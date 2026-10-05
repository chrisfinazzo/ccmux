import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import {
  MARKERS_DIR,
  OPENCODE_PLUGIN_DIR,
  OPENCODE_PLUGIN_FILE,
} from "../../../lib/config";
import pkg from "../../../../package.json" with { type: "json" };
import { BUILTIN_AGENTS, parseMajorVersion } from "../../../lib/agents";
import { VersionResolver } from "../../version-resolver";
import { aggregateOpenCodeMarkers } from "./aggregate";
import {
  findPaneTrackedSession,
  type HookAdapter,
  type HookAdapterOutcome,
  type HookManagerContext,
} from "../../hook-adapter";
import { renderOpenCodePlugin } from "./plugin-script";
import {
  filterMarkerCache,
  type SessionPidMarker,
} from "../../session-markers";

const CCMUX_VERSION: string = pkg.version;

const SENTINEL_PREFIX = "// ccmux-plugin v";
const SENTINEL_REGEX = /^\/\/ ccmux-plugin v(\S+)/;

/** Where OpenCode 2 support is tracked; setup output points users at it. */
const OPENCODE_V2_ISSUE = "https://github.com/epilande/ccmux/issues/214";

/** `opencode --version` from PATH: `1.18.34` on 1.x, `opencode v2.0.21` on 2.x. */
async function readInstalledOpenCodeVersion(): Promise<string | null> {
  const agent = BUILTIN_AGENTS.find((a) => a.name === "opencode");
  if (!agent) return null;
  return new VersionResolver({ timeoutMs: 3000 }).resolve(
    agent,
    agent.executable ?? agent.name,
  );
}

function inspectInstalledPlugin(path: string): {
  exists: boolean;
  owned: boolean;
  version: string | null;
} {
  if (!existsSync(path)) return { exists: false, owned: false, version: null };
  let firstLine: string;
  try {
    firstLine = readFileSync(path, "utf-8").split("\n", 1)[0];
  } catch {
    return { exists: true, owned: false, version: null };
  }
  const match = firstLine.match(SENTINEL_REGEX);
  if (!match) return { exists: true, owned: false, version: null };
  return { exists: true, owned: true, version: match[1] };
}

/**
 * OpenCode plugin-based hook integration.
 *
 * Unlike Claude/Codex, there are no shell scripts to install. `install()`
 * writes a single JS file to OpenCode's auto-discovered plugin directory;
 * `uninstall()` unlinks it. The plugin's first line carries a sentinel
 * (`// ccmux-plugin v<version>`) so we can confirm ownership before
 * overwriting or deleting.
 *
 * Marker lifecycle is driven by the plugin: on every OpenCode bus event
 * it rewrites a `opencode-<session_id>.json` marker. The adapter reads
 * those markers (via `filterMarkerCache`) and folds the N-per-server set
 * into the single ccmux Session for the hosting tmux pane.
 */
export class OpenCodePluginAdapter implements HookAdapter {
  readonly agentType = "opencode";

  private readonly readOpenCodeVersion: () => Promise<string | null>;

  constructor(
    options: {
      /** Version string of the `opencode` on PATH, or null if it cannot be run. */
      readOpenCodeVersion?: () => Promise<string | null>;
    } = {},
  ) {
    this.readOpenCodeVersion =
      options.readOpenCodeVersion ?? readInstalledOpenCodeVersion;
  }

  /** The installed OpenCode's version when it is 2.x or newer, else null. */
  private async detectOpenCode2(): Promise<string | null> {
    const version = await this.readOpenCodeVersion().catch(() => null);
    const major = parseMajorVersion(version);
    return major !== null && major >= 2 ? version : null;
  }

  async install(): Promise<HookAdapterOutcome> {
    const lines: string[] = [];

    const inspection = inspectInstalledPlugin(OPENCODE_PLUGIN_FILE);
    const v2Version = await this.detectOpenCode2();
    if (v2Version) return this.retireForOpenCode2(v2Version, inspection);

    if (inspection.exists && !inspection.owned) {
      // Matches Codex's "advisory, keep going" posture so a combined
      // `ccmux setup` invocation can still install Claude/Codex hooks.
      lines.push(
        `Skipped ${OPENCODE_PLUGIN_FILE}: first line does not start with "${SENTINEL_PREFIX}".`,
      );
      lines.push(
        "Move the existing file aside and re-run `ccmux setup --agent opencode` to install.",
      );
      return { lines, changed: false };
    }

    mkdirSync(OPENCODE_PLUGIN_DIR, { recursive: true });

    const source = renderOpenCodePlugin({
      markersDir: MARKERS_DIR,
      version: CCMUX_VERSION,
    });
    const tmp = `${OPENCODE_PLUGIN_FILE}.tmp.${process.pid}.${Date.now()}`;
    writeFileSync(tmp, source);
    renameSync(tmp, OPENCODE_PLUGIN_FILE);

    lines.push(
      inspection.exists
        ? `Updated plugin: ${OPENCODE_PLUGIN_FILE} (was v${inspection.version ?? "unknown"}, now v${CCMUX_VERSION})`
        : `Created plugin: ${OPENCODE_PLUGIN_FILE}`,
    );
    lines.push("OpenCode will auto-discover the plugin on next launch.");
    lines.push("Restart any running OpenCode sessions to pick up the plugin.");
    return { lines, changed: true };
  }

  /**
   * OpenCode 2 rejects the plugin outright ("Plugin must export a default
   * definition with an id and an effect or setup function"), and a port would
   * not help: its plugins run in one shared background service outside every
   * tmux pane, so a marker's pid could not locate a pane. Setup therefore
   * installs nothing and removes a copy it wrote earlier, which would
   * otherwise raise a load error on every OpenCode launch. A same-named file
   * ccmux did not write is left alone.
   */
  private retireForOpenCode2(
    version: string,
    inspection: ReturnType<typeof inspectInstalledPlugin>,
  ): HookAdapterOutcome {
    const lines = [
      `OpenCode ${version} does not support ccmux's plugin yet, so none was installed.`,
    ];
    let changed = false;
    if (inspection.owned) {
      unlinkSync(OPENCODE_PLUGIN_FILE);
      changed = true;
      lines.push(
        `Removed ${OPENCODE_PLUGIN_FILE}, which OpenCode ${version} rejects at startup.`,
      );
    } else if (inspection.exists) {
      lines.push(
        `Left ${OPENCODE_PLUGIN_FILE} alone: first line does not start with "${SENTINEL_PREFIX}".`,
      );
    }
    lines.push(
      `OpenCode rows still track panes, with status read from the terminal. See ${OPENCODE_V2_ISSUE}`,
    );
    return { lines, changed };
  }

  async uninstall(): Promise<HookAdapterOutcome> {
    const lines: string[] = [];
    const inspection = inspectInstalledPlugin(OPENCODE_PLUGIN_FILE);
    if (!inspection.exists) {
      lines.push(`No ccmux plugin at ${OPENCODE_PLUGIN_FILE}.`);
      return { lines, changed: false };
    }
    if (!inspection.owned) {
      lines.push(
        `Skipped ${OPENCODE_PLUGIN_FILE}: first line does not start with "${SENTINEL_PREFIX}". ` +
          "Refusing to delete a file ccmux did not write.",
      );
      return { lines, changed: false };
    }
    unlinkSync(OPENCODE_PLUGIN_FILE);
    lines.push(`Removed ${OPENCODE_PLUGIN_FILE}`);
    lines.push(
      "Marker files under ~/.config/ccmux/session-pids/ will be swept on the next daemon cycle.",
    );
    return { lines, changed: true };
  }

  isInstalled(): boolean {
    return inspectInstalledPlugin(OPENCODE_PLUGIN_FILE).owned;
  }

  describeInstallDetail(): string | null {
    const inspection = inspectInstalledPlugin(OPENCODE_PLUGIN_FILE);
    if (!inspection.owned || !inspection.version) return null;
    return inspection.version === CCMUX_VERSION
      ? `(plugin v${inspection.version}, matches running ccmux)`
      : `(plugin v${inspection.version})`;
  }

  async describeInstallAnomalies(): Promise<string[]> {
    const inspection = inspectInstalledPlugin(OPENCODE_PLUGIN_FILE);
    if (!inspection.owned) return [];
    const v2Version = await this.detectOpenCode2();
    if (v2Version) {
      return [
        `OpenCode: plugin at ${OPENCODE_PLUGIN_FILE} is installed, but OpenCode ${v2Version} rejects it at startup. ` +
          "Run `ccmux setup --agent opencode` to remove it.",
      ];
    }
    if (inspection.version && inspection.version !== CCMUX_VERSION) {
      return [
        `OpenCode: plugin at ${OPENCODE_PLUGIN_FILE} is v${inspection.version} but ccmux is v${CCMUX_VERSION}. ` +
          "Run `ccmux setup --agent opencode` to update.",
      ];
    }
    return [];
  }

  isSessionStillLive(_marker: SessionPidMarker): boolean {
    // OpenCode has no per-session log to check. The generic PID-liveness
    // sweep in `cleanupStaleMarkers` is the whole story for us.
    return true;
  }

  async onMarkerAdded(
    marker: SessionPidMarker,
    ctx: HookManagerContext,
  ): Promise<void> {
    await this.reaggregate(marker, ctx);
  }

  async onMarkerRemoved(
    marker: SessionPidMarker,
    ctx: HookManagerContext,
  ): Promise<void> {
    // Cache eviction for an unlinked marker happens on the next scan's
    // refreshMarkerCache, so the just-removed marker may still be in the
    // cache. Filter it out so the aggregate reflects reality.
    await this.reaggregate(marker, ctx, marker.session_id);
  }

  async onMarkerChanged(
    marker: SessionPidMarker,
    ctx: HookManagerContext,
  ): Promise<void> {
    // Re-aggregate by server PID rather than session id. Closes the
    // non-winning-sibling gap from the generic resolver: when an
    // OpenCode plugin rewrites any sibling's marker (winning or not),
    // the daemon's `resolveSessionForMarkerEvent(marker.session_id)`
    // would miss for non-winning siblings since `nativeSessionId` only
    // stores the winning marker's id. The adapter has no such issue:
    // `reaggregate` maps `marker.pid` -> pane -> ccmux session in one
    // step.
    await this.reaggregate(marker, ctx);
  }

  private async reaggregate(
    marker: SessionPidMarker,
    ctx: HookManagerContext,
    excludeSessionId?: string,
  ): Promise<void> {
    const target = await this.findTargetSession(marker.pid, ctx);
    if (!target) return;
    const siblings = filterMarkerCache(
      (m) =>
        m.agent_type === this.agentType &&
        m.pid === marker.pid &&
        m.session_id !== excludeSessionId,
    );
    this.applyAggregate(target.sessionId, siblings, ctx);
  }

  private async findTargetSession(
    pid: number,
    ctx: HookManagerContext,
  ): Promise<{ sessionId: string } | null> {
    const pane = await ctx.getPaneHostingPid(pid);
    if (!pane) return null;
    const session = findPaneTrackedSession(ctx, this.agentType, pane.paneId);
    return session ? { sessionId: session.id } : null;
  }

  private applyAggregate(
    sessionId: string,
    siblings: SessionPidMarker[],
    ctx: HookManagerContext,
  ): void {
    const aggregate = aggregateOpenCodeMarkers(siblings);
    const { nativeSessionId, ...state } = aggregate;
    ctx.sessionManager.updateSession(sessionId, state);
    if (nativeSessionId) {
      // Marker-backed, so reclaim: a heuristic holder of this
      // id is stripped and the id re-routes here.
      ctx.sessionManager.setNativeSessionId(sessionId, nativeSessionId, {
        reclaim: true,
      });
    }
  }
}

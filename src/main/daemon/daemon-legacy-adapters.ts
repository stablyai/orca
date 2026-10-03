import { readFileSync, unlinkSync } from 'node:fs'
import {
  getDaemonHistoryDir as getHistoryDir,
  probeDaemonSocket as probeSocket
} from './daemon-launch-paths'
import { parseDaemonPidFile } from './daemon-pid-file-parse'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import { getDaemonPidPath, getDaemonSocketPath, getDaemonTokenPath } from './daemon-spawner'
import { PREVIOUS_DAEMON_PROTOCOL_VERSIONS } from './types'

// Why: this bounds the ENTIRE registry build (every live generation, every session in
// each), not a per-call budget -- one shared absolute deadline is threaded through
// every listSessions/hasChildProcesses call below so a wedged legacy generation
// cannot burn its own 30s REQUEST_TIMEOUT_MS per RPC, times up to 35 previous
// protocol versions, on daemon-init's critical path ahead of installDaemonProvider().
// Kept well under first-window-startup-services.ts's 60s fail-open so a stalled
// legacy generation never eats the budget the CURRENT healthy daemon needs to install.
const LEGACY_GENERATION_REGISTRY_BUILD_BUDGET_MS = 10_000

/** One session discovered under a legacy (non-current) daemon generation. */
export type DaemonLegacyGenerationSessionEntry = {
  readonly sessionId: string
  /**
   * True when the session's foreground process is not a bare shell (a build, an MCP
   * server, etc). Below GET_FOREGROUND_PROCESS_PROTOCOL_VERSION (11) the host has no
   * getForegroundProcess RPC, so this reads conservative-true with no RPC issued: a
   * SAFE DEFAULT (never guess idle), not an accuracy claim about that generation.
   */
  readonly busy: boolean
}

/**
 * A named, read-only inventory of one live legacy daemon generation, discovered at
 * daemon-init time. This is the data layer a UI split-indicator (or a future
 * retirement pass) consumes; it carries no mutation or teardown capability itself.
 */
export type DaemonLegacyGenerationRegistryEntry = {
  readonly protocolVersion: number
  /** Null when the on-disk pid record could not be read or parsed for this generation. */
  readonly pid: number | null
  readonly socketPath: string
  readonly sessions: readonly DaemonLegacyGenerationSessionEntry[]
}

function legacyDaemonProcessMayBeAlive(runtimeDir: string, protocolVersion: number): boolean {
  try {
    const parsed = parseDaemonPidFile(
      readFileSync(getDaemonPidPath(runtimeDir, protocolVersion), 'utf8')
    )
    if (!parsed) {
      return false
    }
    process.kill(parsed.pid, 0)
    return true
  } catch {
    return false
  }
}

// Why: best-effort pid recovery for a LIVE legacy generation's registry entry. Unlike
// legacyDaemonProcessMayBeAlive above, this never probes process liveness (process.kill);
// it only reads whatever record already sits on disk, and a missing or corrupt record
// degrades to null rather than vetoing the adapter the socket probe already proved live.
function readLegacyDaemonPid(runtimeDir: string, protocolVersion: number): number | null {
  try {
    const parsed = parseDaemonPidFile(
      readFileSync(getDaemonPidPath(runtimeDir, protocolVersion), 'utf8')
    )
    return parsed?.pid ?? null
  } catch {
    return null
  }
}

// Why: reuses the adapter's own listSessions()/hasChildProcesses() (no new RPC), the
// same busy/idle read every other daemon-recovery call site already relies on. The
// registry is best-effort diagnostic data, so an inventory failure degrades to an
// empty session list instead of failing daemon startup. deadlineMs is the one shared
// absolute deadline the whole registry build was given -- past it, remainingDaemonRequestTimeoutMs
// collapses each further call's own budget toward zero rather than granting a fresh
// REQUEST_TIMEOUT_MS, so a wedged generation degrades fast into the catch below.
async function buildLegacyGenerationSessions(
  adapter: DaemonPtyAdapter,
  deadlineMs: number
): Promise<DaemonLegacyGenerationSessionEntry[]> {
  try {
    const sessions = await adapter.listSessions({ deadlineMs })
    return await Promise.all(
      sessions.map(async (session) => ({
        sessionId: session.sessionId,
        busy: await adapter.hasChildProcesses(session.sessionId, { deadlineMs })
      }))
    )
  } catch {
    return []
  }
}

// Why: callers that own an isolated runtime namespace must keep discovery history out of app userData.
// deadlineMs defaults to this call's own bounded budget (LEGACY_GENERATION_REGISTRY_BUILD_BUDGET_MS
// from entry), and a caller with a tighter remaining startup budget of its own may pass an
// earlier absolute deadline instead -- either way every generation below shares the SAME one.
export async function createLegacyDaemonAdapters(
  runtimeDir: string,
  historyPath = getHistoryDir(),
  deadlineMs: number = Date.now() + LEGACY_GENERATION_REGISTRY_BUILD_BUDGET_MS
): Promise<{
  adapters: DaemonPtyAdapter[]
  // Why: readonly at the API boundary so a typed caller cannot mutate discovered
  // PID/socket/session state in later reads -- the registry is diagnostic data, not
  // a live handle like the adapters array beside it.
  registry: readonly DaemonLegacyGenerationRegistryEntry[]
}> {
  const adapters: DaemonPtyAdapter[] = []
  const registry: DaemonLegacyGenerationRegistryEntry[] = []
  for (const protocolVersion of PREVIOUS_DAEMON_PROTOCOL_VERSIONS) {
    const socketPath = getDaemonSocketPath(runtimeDir, protocolVersion)
    const tokenPath = getDaemonTokenPath(runtimeDir, protocolVersion)
    if (!(await probeSocket(socketPath))) {
      // Why: a recycled stale pid later turns an identity check into a PowerShell spawn, so delete leaked pid/token files — but only when the pid-process is provably gone (a live daemon can transiently fail the probe, and dropping its token makes its sessions permanently unadoptable).
      if (!legacyDaemonProcessMayBeAlive(runtimeDir, protocolVersion)) {
        for (const stalePath of [
          getDaemonPidPath(runtimeDir, protocolVersion),
          getDaemonTokenPath(runtimeDir, protocolVersion)
        ]) {
          try {
            unlinkSync(stalePath)
          } catch {
            // Best-effort
          }
        }
      }
      continue
    }
    // Keep old-protocol PTYs routed to their original daemon during upgrade; legacy adapters never respawn (new code would recreate stale env semantics).
    // historyPath is still needed for cleanup — without it a later v4 session reusing the same ID could false-restore stale scrollback.bin.
    const adapter = new DaemonPtyAdapter({
      socketPath,
      tokenPath,
      pidPath: getDaemonPidPath(runtimeDir, protocolVersion),
      profileScope: runtimeDir,
      runtimeDir,
      protocolVersion,
      historyPath
    })
    adapters.push(adapter)
    registry.push({
      protocolVersion,
      pid: readLegacyDaemonPid(runtimeDir, protocolVersion),
      socketPath,
      sessions: await buildLegacyGenerationSessions(adapter, deadlineMs)
    })
  }
  return { adapters, registry }
}

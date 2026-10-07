/**
 * orcad's half of the supervision contract: it spawns and supervises the terminal daemon.
 *
 * The whole reason the peer model is recommended over an SSH target is that daemon-backed
 * PTYs stay `live` across a runtime restart (docs/reference/ssh-execution-boundary.md).
 * Without a daemon here, every orcad restart, update and rollback is a SIGKILL for every
 * running terminal — on the host whose selling point is that work survives the client going
 * away.
 *
 * The constraint that makes a restart non-destructive lives in `stopOrcadDaemon` below: the
 * daemon is DETACHED and must outlive this process. Anything that tears it down on the way
 * out silently converts a restart back into data loss.
 */
import {
  disconnectDaemon,
  daemonOwnsFreshPersistentPtys,
  initDaemonPtyProvider,
  readDaemonPidRecord
} from '../daemon/daemon-init'

const WINDOWS_DAEMON_STARTUP_TIMEOUT_MS = 30_000

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export type OrcadDaemonStartup =
  | { state: 'live'; pid: number | null }
  | { state: 'degraded'; reason: string }
  | { state: 'unavailable'; reason: string }

/**
 * Bring the daemon up and install it as the local PTY provider.
 *
 * Fail-open, like the desktop: a host that cannot start a daemon must still serve git,
 * worktrees and non-persistent terminals. What it must NOT do is keep claiming persistence
 * — `daemonOwnsFreshPersistentPtys()` is what the runtime reads for that, and it answers
 * false here without any extra bookkeeping.
 */
export async function startOrcadDaemon(
  platform: NodeJS.Platform = process.platform
): Promise<OrcadDaemonStartup> {
  // Why no login-session watch: that retires the daemon when the spawning macOS GUI login
  // session dies. An orcad daemon must survive its SSH session ending — that is the point.
  const policy = {
    macosLoginSessionWatch: false,
    // A freshly uploaded node.exe plus conpty can take well over 10 s on its first, AV-scanned exec.
    ...(platform === 'win32' ? { startupTimeoutMs: WINDOWS_DAEMON_STARTUP_TIMEOUT_MS } : {})
  }
  try {
    await initDaemonPtyProvider(undefined, policy).catch((error: unknown) => {
      // One warm retry: activation refuses a daemonless candidate, so a cold-start miss would
      // otherwise leave a first deploy serving nothing.
      console.warn(`[orcad] The terminal daemon did not start (${errorMessage(error)}); retrying`)
      return initDaemonPtyProvider(undefined, policy)
    })
  } catch (error) {
    const reason = errorMessage(error)
    console.error(
      `[orcad] The terminal daemon did not start: ${reason}\n` +
        '[orcad] Terminals will run in-process and WILL NOT survive an orcad restart.'
    )
    return { state: 'unavailable', reason }
  }
  if (!daemonOwnsFreshPersistentPtys()) {
    const reason = 'daemon adopted in degraded mode; fresh terminals run on the local provider'
    console.warn(
      `[orcad] ${reason}. Existing daemon sessions keep working, but new terminals will not ` +
        'survive an orcad restart until the daemon is restarted.'
    )
    return { state: 'degraded', reason }
  }
  return { state: 'live', pid: readDaemonPidRecord()?.pid ?? null }
}

/**
 * Release the daemon without killing it.
 *
 * Why `disconnectDaemon` and never `shutdownDaemon`: shutdown kills the daemon process and
 * every PTY under it. Calling it here would make orcad's own restart destructive, which is
 * the exact property this whole item exists to buy.
 */
export async function stopOrcadDaemon(): Promise<void> {
  await disconnectDaemon()
}

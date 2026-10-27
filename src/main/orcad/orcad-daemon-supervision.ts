// Detached terminal daemons must outlive orcad; shutting them down here would kill terminals on restart.
import {
  disconnectDaemon,
  daemonOwnsFreshPersistentPtys,
  readDaemonPidRecord
} from '../daemon/daemon-provider-state'
import { initDaemonPtyProvider } from '../daemon/daemon-provider-init'
import { resolveTerminalSpawnAdmissionMode } from '../daemon/terminal-spawn-gate'
import { errorMessage } from '../../shared/error-message'

const WINDOWS_DAEMON_STARTUP_TIMEOUT_MS = 30_000

type OrcadDaemonStartup =
  | { state: 'live'; pid: number | null }
  | { state: 'degraded'; reason: string }
  | { state: 'unavailable'; reason: string }

/** Continue serving without a daemon on failure, but never claim terminal persistence. */
export async function startOrcadDaemon(
  platform: NodeJS.Platform = process.platform
): Promise<OrcadDaemonStartup> {
  // Daemons must survive SSH logout; macOS GUI-session retirement would kill their terminals.
  const policy = {
    macosLoginSessionWatch: false,
    // Old daemons retain old code/umask; recycle only once terminals cannot be lost.
    recycleStaleDaemonOnEveryPlatform: true,
    spawnAdmission: resolveTerminalSpawnAdmissionMode(),
    // First Windows execution of uploaded Node/conpty may exceed 10 seconds under antivirus.
    ...(platform === 'win32' ? { startupTimeoutMs: WINDOWS_DAEMON_STARTUP_TIMEOUT_MS } : {})
  }
  try {
    await initDaemonPtyProvider(undefined, policy).catch((error: unknown) => {
      // Retry a cold-start miss once: managed activation refuses daemonless candidates.
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

/** Disconnect only: shutdown would kill the daemon and its surviving PTYs. */
export async function stopOrcadDaemon(): Promise<void> {
  await disconnectDaemon()
}

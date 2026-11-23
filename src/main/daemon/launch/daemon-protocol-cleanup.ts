import { unlinkSync } from 'node:fs'
import { DaemonClient } from '../transport/client/daemon-client'
import { DaemonEndpointOwnershipError } from './daemon-endpoint-adoption'
import { probeDaemonSocket as probeSocket } from './daemon-launch-paths'
import { getDaemonPidPath, getDaemonSocketPath, getDaemonTokenPath } from './daemon-spawner'
import { killStaleDaemon } from './daemon-stale-kill'
import { CLEAN_DISCONNECT_PROTOCOL_VERSION } from '../protocol/daemon-protocol-version'
import { countLiveDaemonSessions, type ListSessionsResult } from '../protocol/daemon-rpc-contract'

const DAEMON_SELF_SHUTDOWN_WAIT_MS = 5_000

export type OrphanedDaemonCleanupResult = {
  /** Reports shutdown or confirmed stale-process termination. */
  cleaned: boolean
  /** Number of live PTY sessions killed during cleanup (surfaced to the user). */
  killedCount: number
  /** Live chat relays the stop ended (v63+ daemons); kept apart so PTY counts read as before. */
  killedRelayCount?: number
}

export async function cleanupDaemonForProtocol(
  runtimeDir: string,
  protocolVersion: number,
  /** When set, stop only if the authenticated endpoint owner is this pid; never fall back to a pid kill. */
  expectedOwnerPid?: number
): Promise<OrphanedDaemonCleanupResult> {
  const socketPath = getDaemonSocketPath(runtimeDir, protocolVersion)
  const tokenPath = getDaemonTokenPath(runtimeDir, protocolVersion)
  const pidPath = getDaemonPidPath(runtimeDir, protocolVersion)

  const alive = await probeSocket(socketPath)
  if (!alive) {
    if (protocolVersion >= CLEAN_DISCONNECT_PROTOCOL_VERSION) {
      // An unreachable endpoint does not identify the PID record's owner; leave cleanup to the daemon.
      return { cleaned: false, killedCount: 0 }
    }
    try {
      unlinkSync(pidPath)
    } catch {
      // Old-protocol PID cleanup is best-effort.
    }
    return { cleaned: false, killedCount: 0 }
  }

  const client = new DaemonClient({ socketPath, tokenPath, protocolVersion })
  let killedCount = 0
  let killedRelayCount = 0
  let didRequestShutdown = false
  let didKillStaleDaemon = false
  try {
    await client.ensureConnected()
    if (expectedOwnerPid !== undefined && client.getDaemonIdentity()?.pid !== expectedOwnerPid) {
      throw new DaemonEndpointOwnershipError(
        'Daemon cleanup aborted: the endpoint is owned by a different daemon than expected'
      )
    }
    const sessions = await client
      .request<ListSessionsResult>('listSessions', undefined)
      .catch(() => ({ sessions: [] }))
    killedCount = sessions.sessions.filter((s) => s.isAlive).length
    // Ended relays kept for collection have no agent left to kill.
    killedRelayCount =
      typeof sessions.runningRelays === 'number'
        ? sessions.runningRelays
        : countLiveDaemonSessions(sessions) - killedCount

    // One shutdown RPC avoids racing per-session kills against daemon exit.
    await client.request('shutdown', { killSessions: true }).catch(() => {
      // Shutdown may close the socket before replying.
    })
    didRequestShutdown = true
  } catch (error) {
    if (expectedOwnerPid !== undefined) {
      // A targeted stop never kills by pid: the owner it would find may be a replacement.
      throw error instanceof DaemonEndpointOwnershipError
        ? error
        : new DaemonEndpointOwnershipError(
            'Daemon cleanup aborted: the expected daemon could not be verified'
          )
    }
    // Wedged or older daemons may need PID cleanup when RPC fails; leave the endpoint to its publisher.
    const killOutcome = await killStaleDaemon(runtimeDir, socketPath, tokenPath, protocolVersion)
    didKillStaleDaemon = killOutcome.killed
    if (killOutcome.liveOwnerSurvived) {
      // A surviving owner prevents a replacement from publishing; do not report successful cleanup.
      throw new DaemonEndpointOwnershipError(
        'Daemon cleanup aborted: the existing daemon could not be confirmed stopped'
      )
    }
  } finally {
    client.disconnect()
  }

  if (didRequestShutdown && protocolVersion >= CLEAN_DISCONNECT_PROTOCOL_VERSION) {
    if (!(await waitForDaemonEndpointExit(socketPath))) {
      // Require endpoint shutdown before replacement; the old daemon may still be disposing terminals.
      throw new Error('Timed out waiting for daemon self-shutdown')
    }
    return { cleaned: true, killedCount, killedRelayCount }
  }

  try {
    unlinkSync(pidPath)
  } catch {
    // PID cleanup must not turn successful shutdown into failure.
  }

  return { cleaned: didRequestShutdown || didKillStaleDaemon, killedCount, killedRelayCount }
}

async function waitForDaemonEndpointExit(socketPath: string): Promise<boolean> {
  const deadline = Date.now() + DAEMON_SELF_SHUTDOWN_WAIT_MS
  while (Date.now() < deadline) {
    if (!(await probeSocket(socketPath))) {
      return true
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return !(await probeSocket(socketPath))
}

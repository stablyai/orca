/**
 * Whether the terminal daemon still runs a bridge session in a distro, mounted or not: after a
 * relaunch a hidden worktree's or headless tab's session is live in the daemon though no pane in
 * this app run has noted it, and orchestration, automations or mobile may wake its agent.
 */
import { getDaemonProvider, listLiveDaemonSessions } from '../daemon/daemon-provider-state'
import type { SessionInfo } from '../daemon/daemon-session-info'
import { parseWslUncPath } from '../../shared/wsl-paths'
import { wslHookRelayStateKey } from './wsl-hook-relay-state-key'

/** 'unverifiable' when any daemon generation couldn't answer: the relay then stays. */
export type DaemonBridgeSessionVerdict = 'live' | 'none' | 'unverifiable'

function sessionDistro(session: SessionInfo): string | null {
  if (typeof session.wslDistro === 'string') {
    return session.wslDistro
  }
  // Older daemons omit the field; a session in a WSL folder still names its distro by its cwd.
  return session.wslDistro === undefined && session.cwd
    ? (parseWslUncPath(session.cwd)?.distro ?? null)
    : null
}

export function daemonBridgeSessionVerdict(
  sessions: readonly SessionInfo[] | null,
  distro: string
): DaemonBridgeSessionVerdict {
  if (!sessions) {
    return 'unverifiable'
  }
  const key = wslHookRelayStateKey(distro)
  return sessions.some((session) => {
    const named = sessionDistro(session)
    return session.isAlive && named !== null && wslHookRelayStateKey(named) === key
  })
    ? 'live'
    : 'none'
}

export async function readDaemonBridgeSessions(
  distro: string
): Promise<DaemonBridgeSessionVerdict> {
  // No daemon: local terminals run in this process, and presence already counts them all.
  if (!getDaemonProvider()) {
    return 'none'
  }
  return daemonBridgeSessionVerdict(await listLiveDaemonSessions().catch(() => null), distro)
}

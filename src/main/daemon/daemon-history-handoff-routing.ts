import type { DaemonPtyAdapter } from './daemon-pty-adapter'
import type { DaemonSessionRoute } from './daemon-session-route'

export function createDaemonHistoryHandoffRoute(
  owner: DaemonPtyAdapter,
  target: DaemonPtyAdapter
): DaemonSessionRoute {
  return {
    state: 'unavailable',
    owner,
    incarnation: owner.getLastAuthenticatedDaemonIdentity(),
    historyHandoffTarget: target
  }
}

export function daemonHistoryHandoffTarget(
  route: DaemonSessionRoute | undefined
): DaemonPtyAdapter | undefined {
  return route?.state === 'unavailable' ? route.historyHandoffTarget : undefined
}

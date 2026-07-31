import type { DaemonPtyAdapter } from './daemon-pty-adapter'
import { DaemonSessionUnavailableError } from './daemon-session-route'
import type { DaemonSessionRouteTable } from './daemon-session-route-table'

export function recordValidatedDaemonSpawn(
  routes: DaemonSessionRouteTable,
  resultSessionId: string,
  requestedSessionId: string | undefined,
  owner: DaemonPtyAdapter
): void {
  routes.recordOwned(resultSessionId, owner)
  if (
    routes.getOwned(resultSessionId) !== owner ||
    (requestedSessionId !== undefined && routes.getOwned(requestedSessionId) !== owner)
  ) {
    throw new DaemonSessionUnavailableError(requestedSessionId ?? resultSessionId)
  }
}

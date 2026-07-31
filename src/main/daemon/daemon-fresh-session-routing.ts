import type { DaemonPtyAdapter } from './daemon-pty-adapter'
import {
  DaemonSessionOwnerUnknownError,
  type DaemonSessionRoute,
  DaemonSessionUnavailableError,
  isCurrentOwnedDaemonSessionRoute,
  sameDaemonIncarnation
} from './daemon-session-route'

export function ownerForFreshDaemonSession(
  sessionId: string | undefined,
  route: DaemonSessionRoute | undefined,
  current: DaemonPtyAdapter,
  clearRoute: () => void
): DaemonPtyAdapter {
  if (!sessionId || !route) {
    return current
  }
  if (route.state === 'owned' && route.owner === current) {
    return current
  }
  assertFreshDaemonSessionAvailable(sessionId, route, clearRoute)
  return current
}

export function assertFreshDaemonSessionAvailable(
  sessionId: string | undefined,
  route: DaemonSessionRoute | undefined,
  clearRoute: () => void
): void {
  if (!sessionId || !route) {
    return
  }
  if (route.state === 'unavailable') {
    const ownerIncarnation = route.owner.getLastAuthenticatedDaemonIdentity()
    if (
      route.incarnation &&
      ownerIncarnation &&
      !sameDaemonIncarnation(route.incarnation, ownerIncarnation)
    ) {
      clearRoute()
      return
    }
    throw new DaemonSessionUnavailableError(sessionId)
  }
  throw new DaemonSessionOwnerUnknownError(sessionId)
}

export function recordFreshOwnedDaemonSession(
  route: DaemonSessionRoute | undefined,
  owner: DaemonPtyAdapter,
  transfer: () => void,
  setRoute: (route: DaemonSessionRoute) => void,
  recordOwned: () => void
): void {
  if (
    !route ||
    route.state === 'unavailable' ||
    (route.state === 'owned' && route.owner === owner && !isCurrentOwnedDaemonSessionRoute(route))
  ) {
    transfer()
    return
  }
  if (
    route.state === 'ambiguous' &&
    route.candidates.has(owner) &&
    route.candidates.get(owner) === null
  ) {
    const incarnation = owner.getLastAuthenticatedDaemonIdentity()
    if (incarnation) {
      const candidates = new Map(route.candidates)
      candidates.set(owner, incarnation)
      setRoute({ state: 'ambiguous', candidates })
      return
    }
  }
  recordOwned()
}

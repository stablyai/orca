import type { DaemonEndpointIdentity } from './daemon-hello-protocol'
import type { DaemonPtyAdapter } from './daemon-pty-adapter'
import { createOwnedDaemonSessionRoute, sameDaemonIncarnation } from './daemon-session-route'
import type { DaemonSessionRouteStore } from './daemon-session-route-store'

export function markDaemonSessionUnavailable(
  routes: DaemonSessionRouteStore,
  sessionId: string,
  owner: DaemonPtyAdapter,
  incarnation: DaemonEndpointIdentity | null
): void {
  const route = routes.get(sessionId)
  if (!route) {
    routes.set(sessionId, {
      state: 'unavailable',
      owner,
      incarnation
    })
    return
  }
  if (
    route.state === 'owned' &&
    route.owner === owner &&
    sameDaemonIncarnation(route.incarnation, incarnation)
  ) {
    routes.set(sessionId, {
      state: 'unavailable',
      owner,
      incarnation: route.incarnation
    })
    return
  }
  if (
    route.state !== 'ambiguous' ||
    !route.candidates.has(owner) ||
    !sameDaemonIncarnation(route.candidates.get(owner) ?? null, incarnation)
  ) {
    return
  }
  const candidates = new Map(route.candidates)
  candidates.delete(owner)
  if (candidates.size === 1) {
    for (const [candidate, candidateIncarnation] of candidates) {
      routes.set(sessionId, createOwnedDaemonSessionRoute(candidate, candidateIncarnation))
    }
  } else if (candidates.size > 1) {
    routes.set(sessionId, { state: 'ambiguous', candidates })
  } else {
    routes.set(sessionId, {
      state: 'unavailable',
      owner,
      incarnation
    })
  }
}

export function markDaemonSessionOwnerUnavailable(
  routes: DaemonSessionRouteStore,
  owner: DaemonPtyAdapter,
  incarnation: DaemonEndpointIdentity | null
): void {
  for (const [sessionId, route] of routes) {
    if (
      route.state === 'ambiguous' &&
      route.candidates.has(owner) &&
      sameDaemonIncarnation(route.candidates.get(owner) ?? null, incarnation)
    ) {
      markDaemonSessionUnavailable(routes, sessionId, owner, incarnation)
      continue
    }
    if (
      route.state === 'owned' &&
      route.owner === owner &&
      sameDaemonIncarnation(route.incarnation, incarnation)
    ) {
      routes.set(sessionId, {
        state: 'unavailable',
        owner,
        incarnation: route.incarnation
      })
    }
  }
}

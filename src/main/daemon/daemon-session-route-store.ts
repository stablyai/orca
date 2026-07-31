import type { DaemonPtyAdapter } from './daemon-pty-adapter'
import type { DaemonSessionRoute } from './daemon-session-route'

const MAX_UNAVAILABLE_ROUTES = 1000

export class DaemonSessionRouteStore implements Iterable<[string, DaemonSessionRoute]> {
  private readonly routes = new Map<string, DaemonSessionRoute>()
  private readonly unavailableRouteIds = new Set<string>()
  private unavailableRouteEvicted = false

  get(sessionId: string): DaemonSessionRoute | undefined {
    return this.routes.get(sessionId)
  }

  set(sessionId: string, route: DaemonSessionRoute): void {
    this.routes.set(sessionId, route)
    this.unavailableRouteIds.delete(sessionId)
    if (route.state !== 'unavailable') {
      return
    }
    this.unavailableRouteIds.add(sessionId)
    while (this.unavailableRouteIds.size > MAX_UNAVAILABLE_ROUTES) {
      const oldest = this.unavailableRouteIds.values().next().value
      if (!oldest) {
        return
      }
      this.unavailableRouteIds.delete(oldest)
      if (this.routes.get(oldest)?.state === 'unavailable') {
        this.routes.delete(oldest)
        this.unavailableRouteEvicted = true
      }
    }
  }

  delete(sessionId: string): void {
    this.routes.delete(sessionId)
    this.unavailableRouteIds.delete(sessionId)
  }

  ownedSessionIds(owner: DaemonPtyAdapter): string[] {
    const sessionIds: string[] = []
    for (const [sessionId, route] of this.routes) {
      if (route.state === 'owned' && route.owner === owner) {
        sessionIds.push(sessionId)
      }
    }
    return sessionIds
  }

  hasUnavailableRouteEviction(): boolean {
    return this.unavailableRouteEvicted
  }

  [Symbol.iterator](): MapIterator<[string, DaemonSessionRoute]> {
    return this.routes[Symbol.iterator]()
  }
}

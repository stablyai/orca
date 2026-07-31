import type { DaemonPtyAdapter } from './daemon-pty-adapter'
import {
  createOwnedDaemonSessionRoute,
  DaemonSessionGoneError,
  DaemonSessionOwnerUnknownError,
  DaemonSessionUnavailableError,
  isCurrentOwnedDaemonSessionRoute,
  sameDaemonIncarnation
} from './daemon-session-route'
import { probeDaemonSessionOwner } from './daemon-session-owner-probes'
import { DaemonSessionRouteStore } from './daemon-session-route-store'
import * as freshSessionRouting from './daemon-fresh-session-routing'
import { resolveDaemonSessionOwnerSync } from './daemon-session-owner-sync-resolution'
import { resolveDaemonSessionOwner } from './daemon-session-owner-resolution'
import {
  markDaemonSessionOwnerUnavailable,
  markDaemonSessionUnavailable
} from './daemon-session-route-availability'
import { DaemonSessionOwnerResolutionCache } from './daemon-session-owner-resolution-cache'
import * as historyHandoffRouting from './daemon-history-handoff-routing'

export class DaemonSessionRouteTable {
  private readonly routes = new DaemonSessionRouteStore()
  private readonly incompleteDiscoveries = new Set<DaemonPtyAdapter>()
  private readonly ownerResolutions = new DaemonSessionOwnerResolutionCache()

  constructor(private readonly adapters: readonly DaemonPtyAdapter[]) {}

  readonly get = this.routes.get.bind(this.routes)

  getOwned(sessionId: string): DaemonPtyAdapter | undefined {
    const route = this.routes.get(sessionId)
    return route?.state === 'owned' && isCurrentOwnedDaemonSessionRoute(route)
      ? route.owner
      : undefined
  }

  shouldForwardEvent(sessionId: string, owner: DaemonPtyAdapter): boolean {
    const route = this.routes.get(sessionId)
    if (!route) {
      return !this.routes.hasUnavailableRouteEviction()
    }
    return (
      route.state === 'owned' && route.owner === owner && isCurrentOwnedDaemonSessionRoute(route)
    )
  }

  recordDataOwner(sessionId: string, owner: DaemonPtyAdapter): boolean {
    const route = this.routes.get(sessionId)
    if (!route) {
      if (this.routes.hasUnavailableRouteEviction()) {
        return false
      }
      this.routes.set(sessionId, createOwnedDaemonSessionRoute(owner))
      return true
    }
    if (route.state === 'unavailable') {
      this.recordOwned(sessionId, owner)
      return this.shouldForwardEvent(sessionId, owner)
    }
    if (route.state === 'ambiguous') {
      return false
    }
    if (route.owner === owner) {
      if (isCurrentOwnedDaemonSessionRoute(route)) {
        return true
      }
      this.markUnavailable(sessionId, owner, route.incarnation)
      return false
    }
    this.recordOwned(sessionId, owner)
    return false
  }

  recordOwned(sessionId: string, owner: DaemonPtyAdapter): void {
    this.recordOwnedIncarnation(sessionId, owner, owner.getLastAuthenticatedDaemonIdentity())
  }

  recordOwnedIncarnation(
    sessionId: string,
    owner: DaemonPtyAdapter,
    incarnation: ReturnType<DaemonPtyAdapter['getLastAuthenticatedDaemonIdentity']>
  ): void {
    const route = this.routes.get(sessionId)
    if (!route) {
      if (this.routes.hasUnavailableRouteEviction()) {
        return
      }
      this.routes.set(sessionId, createOwnedDaemonSessionRoute(owner, incarnation))
      return
    }
    if (route.state === 'owned' && route.owner === owner) {
      if (!sameDaemonIncarnation(route.incarnation, incarnation)) {
        this.markUnavailable(sessionId, owner, route.incarnation)
        return
      }
      this.routes.set(sessionId, createOwnedDaemonSessionRoute(owner, incarnation))
      return
    }
    if (route.state === 'unavailable') {
      return
    }
    if (route.state === 'ambiguous' && route.candidates.has(owner)) {
      const candidateIncarnation = route.candidates.get(owner) ?? null
      if (!sameDaemonIncarnation(candidateIncarnation, incarnation)) {
        this.markUnavailable(sessionId, owner, candidateIncarnation)
        return
      }
    }
    const candidates =
      route.state === 'ambiguous'
        ? new Map(route.candidates)
        : new Map([[route.owner, route.incarnation]])
    candidates.set(owner, incarnation)
    this.routes.set(sessionId, { state: 'ambiguous', candidates })
  }

  transfer(
    sessionId: string,
    owner: DaemonPtyAdapter,
    incarnation = owner.getLastAuthenticatedDaemonIdentity()
  ): void {
    this.routes.set(sessionId, createOwnedDaemonSessionRoute(owner, incarnation))
  }

  recordFreshOwned(sessionId: string, owner: DaemonPtyAdapter): void {
    freshSessionRouting.recordFreshOwnedDaemonSession(
      this.routes.get(sessionId),
      owner,
      () => this.transfer(sessionId, owner),
      (route) => this.routes.set(sessionId, route),
      () => this.recordOwned(sessionId, owner)
    )
  }

  recordHistoryHandoff(sessionId: string, owner: DaemonPtyAdapter, target: DaemonPtyAdapter): void {
    this.routes.set(sessionId, historyHandoffRouting.createDaemonHistoryHandoffRoute(owner, target))
  }

  historyHandoffTarget(sessionId: string): DaemonPtyAdapter | undefined {
    return historyHandoffRouting.daemonHistoryHandoffTarget(this.routes.get(sessionId))
  }

  recordDiscoveryFailure(owner: DaemonPtyAdapter): void {
    this.incompleteDiscoveries.add(owner)
  }

  recordCompleteDiscovery(
    owner: DaemonPtyAdapter,
    sessionIds: readonly string[],
    incarnation = owner.getLastAuthenticatedDaemonIdentity()
  ): void {
    for (const sessionId of sessionIds) {
      this.recordOwnedIncarnation(sessionId, owner, incarnation)
    }
    this.incompleteDiscoveries.delete(owner)
  }

  markUnavailable(
    sessionId: string,
    owner: DaemonPtyAdapter,
    incarnation = owner.getLastAuthenticatedDaemonIdentity()
  ): void {
    markDaemonSessionUnavailable(this.routes, sessionId, owner, incarnation)
  }

  markOwnerUnavailable(
    owner: DaemonPtyAdapter,
    incarnation = owner.getLastAuthenticatedDaemonIdentity()
  ): void {
    markDaemonSessionOwnerUnavailable(this.routes, owner, incarnation)
  }

  ownerForFreshSpawn(sessionId: string | undefined, current: DaemonPtyAdapter): DaemonPtyAdapter {
    return freshSessionRouting.ownerForFreshDaemonSession(
      sessionId,
      sessionId ? this.routes.get(sessionId) : undefined,
      current,
      () => sessionId && this.routes.delete(sessionId)
    )
  }

  assertFreshSpawnAvailable(sessionId: string | undefined): void {
    freshSessionRouting.assertFreshDaemonSessionAvailable(
      sessionId,
      sessionId ? this.routes.get(sessionId) : undefined,
      () => sessionId && this.routes.delete(sessionId)
    )
  }

  hasPty(sessionId: string): boolean {
    const route = this.routes.get(sessionId)
    if (!route && this.routes.hasUnavailableRouteEviction()) {
      throw new DaemonSessionOwnerUnknownError(sessionId)
    }
    if (route?.state === 'unavailable') {
      throw new DaemonSessionUnavailableError(sessionId)
    }
    if (route?.state === 'ambiguous') {
      throw new DaemonSessionOwnerUnknownError(sessionId)
    }
    if (route?.state === 'owned') {
      if (!isCurrentOwnedDaemonSessionRoute(route)) {
        this.markUnavailable(sessionId, route.owner, route.incarnation)
        throw new DaemonSessionUnavailableError(sessionId)
      }
      return route.owner.hasPty(sessionId)
    }
    try {
      this.resolveOwnerSync(sessionId)
      return true
    } catch (error) {
      if (error instanceof DaemonSessionGoneError) {
        return false
      }
      throw error
    }
  }

  async resolveOwner(sessionId: string): Promise<DaemonPtyAdapter> {
    const route = this.routes.get(sessionId)
    if (!route && this.routes.hasUnavailableRouteEviction()) {
      throw new DaemonSessionOwnerUnknownError(sessionId)
    }
    if (route?.state === 'owned') {
      if (isCurrentOwnedDaemonSessionRoute(route)) {
        return route.owner
      }
      this.markUnavailable(sessionId, route.owner, route.incarnation)
      throw new DaemonSessionUnavailableError(sessionId)
    }
    if (route?.state === 'unavailable') {
      throw new DaemonSessionUnavailableError(sessionId)
    }
    return await this.ownerResolutions.resolve(sessionId, async () => {
      const discoveryComplete = this.incompleteDiscoveries.size === 0
      const accept = (): void => {
        if (this.routes.get(sessionId) !== route) {
          throw new DaemonSessionOwnerUnknownError(sessionId)
        }
      }
      try {
        return await resolveDaemonSessionOwner({
          sessionId,
          candidates: this.adapters,
          expectedIncarnations: route?.state === 'ambiguous' ? route.candidates : undefined,
          discoveryComplete,
          transfer: (owner, incarnation) => {
            accept()
            this.transfer(sessionId, owner, incarnation)
          },
          recordAmbiguous: (ambiguousCandidates) => {
            accept()
            this.routes.set(sessionId, {
              state: 'ambiguous',
              candidates: ambiguousCandidates
            })
          }
        })
      } catch (error) {
        if (
          error instanceof DaemonSessionGoneError &&
          (this.routes.get(sessionId) !== route ||
            discoveryComplete !== (this.incompleteDiscoveries.size === 0))
        ) {
          throw new DaemonSessionOwnerUnknownError(sessionId)
        }
        throw error
      }
    })
  }

  async probeLiveness(sessionId: string): Promise<boolean | null> {
    const route = this.routes.get(sessionId)
    if (!route && this.routes.hasUnavailableRouteEviction()) {
      return null
    }
    if (route?.state === 'unavailable' || route?.state === 'ambiguous') {
      return null
    }
    if (route?.state === 'owned') {
      if (!isCurrentOwnedDaemonSessionRoute(route)) {
        this.markUnavailable(sessionId, route.owner, route.incarnation)
        return null
      }
      const result = await probeDaemonSessionOwner(route.owner, sessionId)
      return this.routes.get(sessionId) === route &&
        sameDaemonIncarnation(route.incarnation, result.incarnation) &&
        sameDaemonIncarnation(result.incarnation, result.owner.getLastAuthenticatedDaemonIdentity())
        ? result.result
        : null
    }
    try {
      await this.resolveOwner(sessionId)
      return true
    } catch (error) {
      return error instanceof DaemonSessionGoneError ? false : null
    }
  }

  resolveOwnerSync(sessionId: string): DaemonPtyAdapter {
    const route = this.routes.get(sessionId)
    if (!route && this.routes.hasUnavailableRouteEviction()) {
      throw new DaemonSessionOwnerUnknownError(sessionId)
    }
    if (route?.state === 'owned' && !isCurrentOwnedDaemonSessionRoute(route)) {
      this.markUnavailable(sessionId, route.owner, route.incarnation)
      throw new DaemonSessionUnavailableError(sessionId)
    }
    return resolveDaemonSessionOwnerSync({
      sessionId,
      route,
      discoveryIncomplete: this.incompleteDiscoveries.size > 0,
      adapters: this.adapters,
      transfer: (owner, incarnation) => this.transfer(sessionId, owner, incarnation),
      recordAmbiguous: (candidates) =>
        this.routes.set(sessionId, { state: 'ambiguous', candidates })
    })
  }

  readonly getOwnedSessionIds = this.routes.ownedSessionIds.bind(this.routes)
}

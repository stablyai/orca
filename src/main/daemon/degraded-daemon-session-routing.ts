import type { IPtyProvider, PtySpawnOptions, PtySpawnResult } from '../providers/types'
import type { DaemonPtyAdapter } from './daemon-pty-adapter'
import { shutdownDegradedFallbackSessions } from './degraded-daemon-fallback-shutdown'
import { DaemonSessionRouteTable } from './daemon-session-route-table'
import { DaemonSessionOwnerUnknownError, sameDaemonIncarnation } from './daemon-session-route'
import type { DaemonSnapshotAcknowledgementRoutes } from './daemon-snapshot-acknowledgement-routes'
import { DegradedFallbackSessionRoutes as FallbackRoutes } from './degraded-fallback-session-routes'
import { DegradedFallbackSpawnRoutes } from './degraded-fallback-spawn-routes'

export class DegradedDaemonSessionRouting {
  private readonly adapters: DaemonPtyAdapter[]
  private readonly adapterSet: ReadonlySet<DaemonPtyAdapter>
  private readonly routes: DaemonSessionRouteTable
  private readonly fallbackOwners = new Map<string, IPtyProvider>()
  private readonly fallbackRoutes: FallbackRoutes
  private readonly fallbackSpawns = new DegradedFallbackSpawnRoutes()
  private readonly identityUnsubscribes: (() => void)[] = []

  constructor(
    private readonly current: DaemonPtyAdapter,
    legacy: readonly DaemonPtyAdapter[],
    private readonly fallback: IPtyProvider,
    private readonly snapshotAcks: DaemonSnapshotAcknowledgementRoutes
  ) {
    this.adapters = [current, ...legacy]
    this.adapterSet = new Set(this.adapters)
    this.routes = new DaemonSessionRouteTable(this.adapters)
    this.fallbackRoutes = new FallbackRoutes(this.fallbackOwners, this.routes, this.fallbackSpawns)
    for (const adapter of this.adapters) {
      this.identityUnsubscribes.push(
        adapter.onDaemonIdentityChanged(({ previous }) => {
          this.snapshotAcks.dropAdapterIncarnation(adapter, previous)
          this.fallbackRoutes.markDaemonOwnerUnavailable(adapter, previous)
        })
      )
    }
  }

  async discover(): Promise<void> {
    for (const adapter of this.adapters) {
      try {
        const before = adapter.getLastAuthenticatedDaemonIdentity()
        const sessions = await adapter.listProcesses()
        const incarnation = adapter.getLastAuthenticatedDaemonIdentity()
        if (before && !sameDaemonIncarnation(before, incarnation)) {
          throw new Error('daemon incarnation changed during session discovery')
        }
        this.routes.recordCompleteDiscovery(
          adapter,
          sessions.map((session) => session.id),
          incarnation
        )
        for (const session of sessions) {
          if (this.fallbackOwners.has(session.id)) {
            this.fallbackRoutes.recordCollision(session.id)
          }
        }
      } catch (error) {
        this.routes.recordDiscoveryFailure(adapter)
        console.warn('[daemon] Failed to discover degraded daemon sessions', error)
      }
    }
  }

  async spawn(opts: PtySpawnOptions): Promise<PtySpawnResult> {
    const targetOrPromise = this.spawnTarget(opts)
    const target = targetOrPromise instanceof Promise ? await targetOrPromise : targetOrPromise
    const inFlightFallbackId = target === this.fallback ? opts.sessionId : undefined
    if (inFlightFallbackId) {
      this.fallbackSpawns.begin(inFlightFallbackId)
    }
    try {
      const result = await target.spawn(opts)
      if (target === this.fallback) {
        if (!this.fallbackSpawns.hasExited(result.id)) {
          this.fallbackRoutes.recordSpawnedSession(result.id, target)
        }
        this.fallbackRoutes.assertExistingSpawnAvailable(opts, result.id)
      } else {
        this.fallbackRoutes.recordDaemonSpawn(result.id, opts.sessionId, target as DaemonPtyAdapter)
      }
      return result
    } finally {
      if (inFlightFallbackId) {
        this.fallbackSpawns.end(inFlightFallbackId)
        if (!this.fallbackSpawns.hasLiveCandidate(inFlightFallbackId)) {
          this.fallbackRoutes.clearUnownedCollision(inFlightFallbackId)
        }
      }
    }
  }

  providerFor(sessionId: string): IPtyProvider {
    if (this.fallbackRoutes.hasCollision(sessionId)) {
      throw new DaemonSessionOwnerUnknownError(sessionId)
    }
    return this.fallbackOwners.get(sessionId) ?? this.routes.resolveOwnerSync(sessionId)
  }

  ownerForHint(sessionId: string): IPtyProvider | null {
    try {
      return this.providerFor(sessionId)
    } catch {
      return null
    }
  }

  hasPty(sessionId: string): boolean {
    if (this.fallbackRoutes.hasCollision(sessionId)) {
      return true
    }
    const fallback = this.fallbackOwners.get(sessionId)
    return fallback ? (fallback.hasPty?.(sessionId) ?? true) : this.routes.hasPty(sessionId)
  }

  async probePtyLiveness(sessionId: string): Promise<boolean | null> {
    if (this.fallbackRoutes.hasCollision(sessionId)) {
      return null
    }
    const probe = this.fallbackRoutes.captureLivenessProbe(sessionId)
    if (!probe) {
      return await this.routes.probeLiveness(sessionId)
    }
    const result = probe.provider.probePtyLiveness
      ? await probe.provider.probePtyLiveness(sessionId)
      : (probe.provider.hasPty?.(sessionId) ?? null)
    return this.fallbackRoutes.acceptsLivenessResult(sessionId, probe) ? result : null
  }

  shouldForwardStreamEvent(provider: IPtyProvider, sessionId: string): boolean {
    const adapter = this.daemonAdapter(provider)
    if (adapter) {
      if (this.fallbackOwners.has(sessionId)) {
        this.routes.recordFreshOwned(sessionId, adapter)
        this.fallbackRoutes.recordCollision(sessionId)
        return false
      }
      const shouldForward = this.routes.recordDataOwner(sessionId, adapter)
      if (!this.fallbackSpawns.hasLiveCandidate(sessionId)) {
        return shouldForward
      }
      this.fallbackRoutes.recordCollision(sessionId)
      return false
    }
    const route = this.routes.get(sessionId)
    if (!route) {
      return (
        !this.fallbackSpawns.hasExited(sessionId) &&
        (this.fallbackOwners.get(sessionId) === provider ||
          this.fallbackSpawns.isInFlight(sessionId))
      )
    }
    if (
      (this.fallbackOwners.get(sessionId) === provider ||
        this.fallbackSpawns.hasLiveCandidate(sessionId)) &&
      route.state === 'unavailable' &&
      !this.fallbackRoutes.hasCollision(sessionId)
    ) {
      this.fallbackRoutes.clearCollision(sessionId)
      return true
    }
    this.fallbackRoutes.recordCollision(sessionId)
    return false
  }

  shouldForwardWriteUnavailable(adapter: DaemonPtyAdapter, sessionId: string): boolean {
    return this.fallbackRoutes.shouldForwardWriteUnavailable(sessionId, adapter)
  }

  recordExit(provider: IPtyProvider, sessionId: string): boolean {
    const adapter = this.daemonAdapter(provider)
    if (!adapter) {
      const isOwned =
        this.fallbackOwners.get(sessionId) === provider ||
        this.fallbackSpawns.hasLiveCandidate(sessionId)
      if (!isOwned) {
        return false
      }
      this.fallbackSpawns.recordExit(sessionId)
      this.fallbackRoutes.deleteSession(sessionId)
      const route = this.routes.get(sessionId)
      return !route || route.state === 'unavailable'
    }
    this.snapshotAcks.dropForProducer(sessionId, adapter)
    if (this.fallbackOwners.has(sessionId) || this.fallbackSpawns.hasLiveCandidate(sessionId)) {
      this.routes.markUnavailable(sessionId, adapter)
      if (this.routes.get(sessionId)?.state === 'unavailable') {
        this.fallbackRoutes.clearCollision(sessionId)
      }
      return false
    }
    const shouldForward = this.routes.shouldForwardEvent(sessionId, adapter)
    this.routes.markUnavailable(sessionId, adapter)
    return shouldForward
  }

  recordShutdown(sessionId: string, provider: IPtyProvider, keepHistory?: boolean): void {
    if (keepHistory) {
      return
    }
    if (provider === this.fallback) {
      this.fallbackRoutes.deleteSession(sessionId)
    } else {
      const adapter = provider as DaemonPtyAdapter
      this.routes.markUnavailable(sessionId, adapter)
      this.snapshotAcks.dropForProducer(sessionId, adapter)
    }
  }

  async reconcile(validWorktreeIds: Set<string>): Promise<{ alive: string[]; killed: string[] }> {
    const alive: string[] = []
    const killed: string[] = []
    const reconciled: {
      adapter: DaemonPtyAdapter
      incarnation: ReturnType<DaemonPtyAdapter['getLastAuthenticatedDaemonIdentity']>
      alive: string[]
      killed: string[]
    }[] = []
    for (const adapter of this.adapters) {
      const before = adapter.getLastAuthenticatedDaemonIdentity()
      const result = await adapter.reconcileOnStartup(validWorktreeIds)
      const incarnation = adapter.getLastAuthenticatedDaemonIdentity()
      if (before && !sameDaemonIncarnation(before, incarnation)) {
        this.routes.markOwnerUnavailable(adapter, before)
        throw new Error('daemon incarnation changed during startup reconciliation')
      }
      reconciled.push({ adapter, incarnation, ...result })
      for (const id of result.alive) {
        alive.push(id)
      }
      for (const id of result.killed) {
        killed.push(id)
      }
    }
    for (const { adapter, incarnation } of reconciled) {
      if (!sameDaemonIncarnation(incarnation, adapter.getLastAuthenticatedDaemonIdentity())) {
        this.routes.markOwnerUnavailable(adapter, incarnation)
        throw new Error('daemon incarnation changed during startup reconciliation')
      }
    }
    for (const { adapter, incarnation, alive: sessionIds } of reconciled) {
      for (const id of sessionIds) {
        this.routes.recordOwnedIncarnation(id, adapter, incarnation)
        if (this.fallbackOwners.has(id)) {
          this.fallbackRoutes.recordCollision(id)
        }
      }
    }
    for (const { adapter, incarnation, killed: sessionIds } of reconciled) {
      for (const id of sessionIds) {
        this.routes.markUnavailable(id, adapter, incarnation)
        this.snapshotAcks.dropForProducer(id, adapter, incarnation)
        if (this.routes.get(id)?.state === 'unavailable') {
          this.fallbackRoutes.clearCollision(id)
        }
      }
    }
    return { alive, killed }
  }

  clearTombstone(sessionId: string): void {
    this.routes.getOwned(sessionId)?.clearTombstone(sessionId)
  }

  currentSessionIds(): string[] {
    return this.routes.getOwnedSessionIds(this.current)
  }

  recordCurrentSyntheticExits(): string[] {
    const forwarded: string[] = []
    for (const id of this.currentSessionIds()) {
      if (this.routes.shouldForwardEvent(id, this.current)) {
        forwarded.push(id)
      }
      this.routes.markUnavailable(id, this.current)
      this.snapshotAcks.dropForProducer(id, this.current)
      if (this.routes.get(id)?.state === 'unavailable') {
        this.fallbackRoutes.clearCollision(id)
      }
    }
    return forwarded
  }

  async shutdownFallbackSessions(): Promise<number> {
    const count = await shutdownDegradedFallbackSessions(this.fallbackOwners, this.fallback)
    this.fallbackRoutes.pruneSessionEpochs()
    return count
  }

  allProviders(): IPtyProvider[] {
    return [this.fallback, ...this.adapters]
  }

  allAdapters(): readonly DaemonPtyAdapter[] {
    return this.adapters
  }

  dispose(): void {
    for (const unsubscribe of this.identityUnsubscribes.splice(0)) {
      unsubscribe()
    }
    this.fallbackRoutes.clear()
    this.fallbackSpawns.clear()
    this.snapshotAcks.clear()
  }

  private spawnTarget(opts: PtySpawnOptions): IPtyProvider | Promise<IPtyProvider> {
    if (opts.sessionId && this.fallbackRoutes.hasCollision(opts.sessionId)) {
      throw new DaemonSessionOwnerUnknownError(opts.sessionId)
    }
    if (!opts.sessionId || opts.isNewSession) {
      this.routes.assertFreshSpawnAvailable(opts.sessionId)
      return this.fallback
    }
    return this.fallbackOwners.get(opts.sessionId) ?? this.routes.resolveOwner(opts.sessionId)
  }

  private daemonAdapter(provider: IPtyProvider): DaemonPtyAdapter | null {
    return this.adapterSet.has(provider as DaemonPtyAdapter) ? (provider as DaemonPtyAdapter) : null
  }
}

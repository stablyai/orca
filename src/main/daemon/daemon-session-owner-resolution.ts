import {
  indexDaemonOwnerInventory,
  resolveDaemonInventoryOwner,
  resolveDaemonInventoryTerminationOwner,
  selectListedDaemonProcesses,
  type OwnerInventory,
  type ProviderInventory
} from './daemon-session-owner-inventory'
import type {
  IPtyProvider,
  PtyProcessInfo,
  PtySpawnOptions,
  PtySpawnResult
} from '../providers/pty-provider-contract'
import { TerminalSessionOwnerUnverifiedError } from './daemon-errors'
import { spawnDaemonAttachOnly } from './daemon-session-owner-attach'
import { awaitDaemonWorkWithinCallerDeadline } from './daemon-request-deadline'

export type DaemonSessionOwnerResolution<T extends IPtyProvider> =
  | { kind: 'owner'; provider: T }
  | { kind: 'absent' }
  | { kind: 'unknown' }

const OWNER_RESOLUTION_TIMEOUT_MS = 2_000
const OWNER_INVENTORY_CACHE_MS = 1_000
const FAILED_PROVIDER_COOLDOWN_MS = 1_000

export class DaemonSessionOwnerResolver<T extends IPtyProvider> {
  private inventoryInFlight: Promise<OwnerInventory<T>> | null = null
  private cachedInventory: { value: OwnerInventory<T>; expiresAt: number } | null = null
  private readonly failedProviderCooldowns = new Map<T, number>()
  private readonly routeIncarnations = new Map<string, string | undefined>()
  private epoch = 0

  private readonly providers: T[]

  constructor(
    providers: readonly T[],
    private readonly routes: Map<string, IPtyProvider>,
    private readonly isProviderProvenGone?: (provider: T, error: unknown) => boolean
  ) {
    this.providers = [...providers]
  }

  // Why no epoch bump on its own: a proven-gone provider lists nothing, so in-flight inventories stay valid.
  private forgetProvider(provider: T): void {
    const index = this.providers.indexOf(provider)
    if (index !== -1) {
      this.providers.splice(index, 1)
    }
    this.failedProviderCooldowns.delete(provider)
    this.forgetRoutesOf(provider)
  }

  private forgetRoutesOf(provider: T): void {
    for (const [sessionId, routed] of this.routes) {
      if (routed === provider) {
        this.removeRoute(sessionId)
      }
    }
  }

  invalidateProvider(provider: T): void {
    this.invalidateInventory()
    this.forgetRoutesOf(provider)
    this.failedProviderCooldowns.clear()
    // Another resolver may already have removed this provider's shared routes.
    for (const sessionId of this.routeIncarnations.keys()) {
      if (!this.routes.has(sessionId)) {
        this.routeIncarnations.delete(sessionId)
      }
    }
  }

  async spawnAttachOnly(opts: PtySpawnOptions & { sessionId: string }): Promise<PtySpawnResult> {
    return spawnDaemonAttachOnly(opts, this.providers, this.routes, this.routeIncarnations, this)
  }

  async probe(sessionId: string): Promise<boolean | null> {
    const routed = this.providers.find((provider) => provider === this.routes.get(sessionId))
    const direct = routed ?? (this.providers.length === 1 ? this.providers[0] : undefined)
    if (direct) {
      const verdict = direct.probePtyLiveness
        ? await direct.probePtyLiveness(sessionId)
        : (direct.hasPty?.(sessionId) ?? null)
      if (verdict !== false || this.providers.length === 1) {
        return verdict
      }
      if (this.routes.get(sessionId) === routed) {
        this.removeRoute(sessionId)
      }
    }
    const inventory = await this.inventory(false)
    if (inventory.epoch !== this.epoch) {
      return null
    }
    if ((inventory.candidatesBySessionId.get(sessionId)?.length ?? 0) > 0) {
      return true
    }
    return inventory.complete && this.providers.length > 0 ? false : null
  }

  async resolve(
    sessionId: string,
    expectedIncarnationId?: string,
    expectedIncarnationIsAuthoritative = false
  ): Promise<DaemonSessionOwnerResolution<T>> {
    const inventory = await this.inventory()
    if (inventory.epoch !== this.epoch) {
      return { kind: 'unknown' }
    }
    const resolution = resolveDaemonInventoryOwner(
      inventory,
      sessionId,
      this.providers.length > 0,
      (id, provider, incarnationId) => this.setRoute(id, provider, incarnationId),
      expectedIncarnationId,
      expectedIncarnationIsAuthoritative
    )
    if (
      (!inventory.complete || resolution.kind === 'unknown') &&
      this.cachedInventory?.value !== inventory
    ) {
      this.cachedInventory = {
        value: inventory,
        expiresAt: Date.now() + OWNER_INVENTORY_CACHE_MS
      }
    }
    return resolution
  }

  resolveTermination = async (sessionId: string, incarnationId: string) => {
    const routed = this.providers.find((provider) => provider === this.routes.get(sessionId))
    if (routed && this.routeIncarnations.get(sessionId) === incarnationId) {
      return { kind: 'owner' as const, provider: routed }
    }
    // Another session's cached inventory cannot prove this one exited.
    const inventory = await this.inventory(false)
    if (inventory.epoch !== this.epoch) {
      return { kind: 'unknown' as const }
    }
    return resolveDaemonInventoryTerminationOwner(
      inventory,
      sessionId,
      this.providers.length > 0,
      (id, provider, incarnationId) => this.setRoute(id, provider, incarnationId),
      incarnationId
    )
  }

  async discoverRoutes(): Promise<void> {
    // Explicit discovery supersedes pending observations; ordinary readers share them.
    this.invalidateInventory()
    await this.inventory(false)
    this.failedProviderCooldowns.clear()
    this.cachedInventory = null
  }

  async listProcesses(
    opts?: Parameters<IPtyProvider['listProcesses']>[0]
  ): Promise<PtyProcessInfo[]> {
    const pending = this.inventory(false, opts, true)
    if (
      opts?.deadlineMs !== undefined &&
      !(await awaitDaemonWorkWithinCallerDeadline(
        pending.then(() => {}),
        opts.deadlineMs
      ))
    ) {
      throw new TerminalSessionOwnerUnverifiedError('inventory deadline')
    }
    const inventory = await pending
    if (inventory.epoch !== this.epoch) {
      throw new TerminalSessionOwnerUnverifiedError('stale inventory')
    }
    if (inventory.failure) {
      throw inventory.failure.error
    }
    return selectListedDaemonProcesses(
      inventory,
      this.routes,
      this.routeIncarnations,
      opts?.includeUnrouted
    )
  }

  recordRoute(sessionId: string, provider: T, incarnationId?: string): void {
    if (
      incarnationId &&
      this.routes.get(sessionId) === provider &&
      this.routeIncarnations.get(sessionId) === incarnationId
    ) {
      return
    }
    this.invalidateInventory()
    this.setRoute(sessionId, provider, incarnationId)
  }

  private setRoute(sessionId: string, provider: T, incarnationId?: string): void {
    this.routes.set(sessionId, provider)
    this.routeIncarnations.set(sessionId, incarnationId)
  }

  forgetRoute(sessionId: string, provider?: T): void {
    if (provider && this.routes.get(sessionId) !== provider) {
      return
    }
    this.invalidateInventory()
    this.removeRoute(sessionId)
  }

  private removeRoute(sessionId: string): void {
    this.routes.delete(sessionId)
    this.routeIncarnations.delete(sessionId)
  }

  private invalidateInventory(): void {
    this.epoch += 1
    this.inventoryInFlight = null
    this.cachedInventory = null
  }

  private inventory(
    allowCached = true,
    opts?: Parameters<IPtyProvider['listProcesses']>[0],
    retryFailedProviders = false
  ): Promise<OwnerInventory<T>> {
    if (this.inventoryInFlight) {
      return this.inventoryInFlight
    }
    if (
      allowCached &&
      this.cachedInventory?.value.epoch === this.epoch &&
      this.cachedInventory.expiresAt > Date.now()
    ) {
      return Promise.resolve(this.cachedInventory.value)
    }
    this.cachedInventory = null
    // A restore can join diagnostics, so every shared acquisition keeps the restore budget.
    const deadlineMs = Math.min(
      opts?.deadlineMs ?? Infinity,
      Date.now() + OWNER_RESOLUTION_TIMEOUT_MS
    )
    const epoch = this.epoch
    const inventory = Promise.all(
      this.providers.map(async (provider): Promise<ProviderInventory<T>> => {
        if (
          !retryFailedProviders &&
          (this.failedProviderCooldowns.get(provider) ?? 0) > Date.now()
        ) {
          return { provider, processes: null }
        }
        this.failedProviderCooldowns.delete(provider)
        try {
          return { provider, processes: await provider.listProcesses({ deadlineMs }) }
        } catch (error) {
          // A provider proven gone owns nothing; leaving it would keep every attach unverifiable.
          if (this.isProviderProvenGone?.(provider, error)) {
            this.forgetProvider(provider)
            return { provider, processes: [] }
          }
          if (epoch === this.epoch) {
            this.failedProviderCooldowns.set(provider, Date.now() + FAILED_PROVIDER_COOLDOWN_MS)
          }
          return { provider, processes: null, failure: { error } }
        }
      })
    )
      .then((entries) => this.indexInventory(entries, epoch))
      .finally(() => {
        if (this.inventoryInFlight === inventory) {
          this.inventoryInFlight = null
        }
      })
    this.inventoryInFlight = inventory
    return inventory
  }

  private indexInventory(entries: ProviderInventory<T>[], epoch: number): OwnerInventory<T> {
    return indexDaemonOwnerInventory(
      entries,
      epoch,
      this.epoch,
      (id, provider, incarnationId) => this.setRoute(id, provider, incarnationId),
      (id) => this.removeRoute(id),
      (id) => {
        const provider = this.providers.find((candidate) => candidate === this.routes.get(id))
        return provider ? { provider, incarnationId: this.routeIncarnations.get(id) } : undefined
      }
    )
  }
}

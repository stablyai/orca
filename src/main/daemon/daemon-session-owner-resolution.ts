import { attachSessionToOwner } from './daemon-session-attach-owner'
import {
  indexOwnerInventory,
  selectInventoryOwner,
  type OwnerInventory,
  type ProviderInventory
} from './daemon-session-owner-inventory'
import {
  DaemonSessionRouteAuthority,
  type RouteObservation
} from './daemon-session-route-authority'
import type { IPtyProvider, PtySpawnOptions, PtySpawnResult } from '../providers/types'
import { TerminalSessionOwnerUnverifiedError } from './daemon-errors'

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
  readonly authority: DaemonSessionRouteAuthority<T>
  private epoch = 0

  constructor(
    private providers: readonly T[],
    private readonly routes: Map<string, IPtyProvider>
  ) {
    this.authority = new DaemonSessionRouteAuthority(routes)
  }

  runWithCustody<R>(
    id: string,
    operation: (observation: RouteObservation) => Promise<R>
  ): Promise<R> {
    return this.authority.run(id, (observation) => {
      this.inventoryInFlight = null
      this.cachedInventory = null
      return operation(observation)
    })
  }

  removeProvider(provider: T): void {
    this.invalidateProvider(provider)
    this.providers = this.providers.filter((candidate) => candidate !== provider)
  }

  invalidateProvider(provider: T): void {
    this.epoch += 1
    this.inventoryInFlight = null
    this.cachedInventory = null
    this.failedProviderCooldowns.clear()
    this.authority.invalidateProvider(provider)
  }

  spawnAttachOnly(
    opts: PtySpawnOptions & { sessionId: string },
    admission?: RouteObservation
  ): Promise<PtySpawnResult> {
    return attachSessionToOwner(this, this.providers, this.routes, opts, admission)
  }

  async probe(sessionId: string): Promise<boolean | null> {
    const observation = this.authority.capture()
    const routed = this.providers.find((provider) => provider === this.routes.get(sessionId))
    const direct = routed ?? (this.providers.length === 1 ? this.providers[0] : undefined)
    if (direct) {
      const verdict = direct.probePtyLiveness
        ? await direct.probePtyLiveness(sessionId)
        : (direct.hasPty?.(sessionId) ?? null)
      if (!this.authority.isCurrent(sessionId, observation)) {
        return null
      }
      if (verdict !== false || this.providers.length === 1) {
        return verdict
      }
      if (this.routes.get(sessionId) === routed) {
        this.forgetRoute(sessionId, routed, observation)
      }
    }
    const inventory = await this.inventory(false)
    if (
      inventory.epoch !== this.epoch ||
      !this.authority.isCurrent(sessionId, inventory.observation)
    ) {
      return null
    }
    if ((inventory.candidatesBySessionId.get(sessionId)?.length ?? 0) > 0) {
      return true
    }
    const resolution = this.resolveInventory(inventory, sessionId)
    if (resolution.kind === 'owner') {
      return resolution.provider === routed ? null : true
    }
    return resolution.kind === 'absent' ? false : null
  }

  async resolve(
    sessionId: string,
    expectedIncarnationId?: string,
    expectedIncarnationIsAuthoritative = false,
    admission?: RouteObservation
  ): Promise<DaemonSessionOwnerResolution<T>> {
    const inventory = await this.inventory()
    if (inventory.epoch !== this.epoch) {
      return { kind: 'unknown' }
    }
    const resolution = this.resolveInventory(
      inventory,
      sessionId,
      expectedIncarnationId,
      expectedIncarnationIsAuthoritative,
      admission
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

  async discoverRoutes(): Promise<void> {
    await this.inventory()
    this.failedProviderCooldowns.clear()
    this.cachedInventory = null
  }

  async publishSpawnResult(
    result: PtySpawnResult,
    provider: T,
    observation: RouteObservation
  ): Promise<void> {
    if (this.recordRoute(result.id, provider, result.incarnationId, observation)) {
      return
    }
    const refreshed = this.authority.refreshAdmission(observation)
    if (refreshed && result.incarnationId && this.providers.includes(provider)) {
      const processes = await provider.listProcesses({
        deadlineMs: Date.now() + OWNER_RESOLUTION_TIMEOUT_MS
      })
      if (
        processes.some(
          (process) => process.id === result.id && process.incarnationId === result.incarnationId
        ) &&
        this.recordRoute(result.id, provider, result.incarnationId, refreshed)
      ) {
        return
      }
    }
    throw new TerminalSessionOwnerUnverifiedError(result.id)
  }

  recordRoute(
    sessionId: string,
    provider: T,
    incarnationId?: string,
    observation?: RouteObservation
  ): boolean {
    return this.authority.record(sessionId, provider, incarnationId, observation)
  }

  forgetRoute(sessionId: string, provider?: T, observation?: RouteObservation): void {
    if (this.authority.forget(sessionId, provider, observation)) {
      this.cachedInventory = null
    }
  }

  private resolveInventory(
    inventory: OwnerInventory<T>,
    sessionId: string,
    expectedIncarnationId?: string,
    expectedIncarnationIsAuthoritative = false,
    admission?: RouteObservation
  ): DaemonSessionOwnerResolution<T> {
    const observation = admission
      ? { ...inventory.observation, admission: admission.admission }
      : inventory.observation
    if (!this.authority.isCurrent(sessionId, observation)) {
      return { kind: 'unknown' }
    }
    const resolution = selectInventoryOwner(
      inventory,
      sessionId,
      this.providers.length,
      expectedIncarnationId,
      expectedIncarnationIsAuthoritative
    )
    if (resolution.kind === 'owner') {
      const process = inventory.candidatesBySessionId
        .get(sessionId)
        ?.find((candidate) => candidate.provider === resolution.provider)?.process
      if (
        !this.recordRoute(
          sessionId,
          resolution.provider,
          process?.incarnationId,
          admission ?? observation
        )
      ) {
        return { kind: 'unknown' }
      }
    }
    return resolution
  }

  private inventory(allowCached = true): Promise<OwnerInventory<T>> {
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
    const deadlineMs = Date.now() + OWNER_RESOLUTION_TIMEOUT_MS
    const epoch = this.epoch
    const observation = this.authority.capture()
    const inventory = Promise.all(
      this.providers.map(async (provider): Promise<ProviderInventory<T>> => {
        if ((this.failedProviderCooldowns.get(provider) ?? 0) > Date.now()) {
          return { provider, processes: null }
        }
        this.failedProviderCooldowns.delete(provider)
        try {
          return { provider, processes: await provider.listProcesses({ deadlineMs }) }
        } catch {
          if (epoch === this.epoch) {
            this.failedProviderCooldowns.set(provider, Date.now() + FAILED_PROVIDER_COOLDOWN_MS)
          }
          return { provider, processes: null }
        }
      })
    )
      .then((entries) => this.indexInventory(entries, epoch, observation))
      .finally(() => {
        if (this.inventoryInFlight === inventory) {
          this.inventoryInFlight = null
        }
      })
    this.inventoryInFlight = inventory
    return inventory
  }

  private indexInventory(
    entries: ProviderInventory<T>[],
    epoch: number,
    observation: RouteObservation
  ): OwnerInventory<T> {
    const inventory = indexOwnerInventory(entries, epoch, observation)
    const { candidatesBySessionId, complete } = inventory
    if (complete && epoch === this.epoch) {
      for (const [sessionId, candidates] of candidatesBySessionId) {
        const providers = new Set(candidates.map(({ provider }) => provider))
        if (providers.size === 1) {
          const provider = providers.values().next().value!
          const process = candidates.find((candidate) => candidate.provider === provider)?.process
          this.recordRoute(sessionId, provider, process?.incarnationId, observation)
        } else {
          this.forgetRoute(sessionId, undefined, observation)
        }
      }
    }
    return inventory
  }
}

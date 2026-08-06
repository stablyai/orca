import type {
  IPtyProvider,
  PtyProcessInfo,
  PtySpawnOptions,
  PtySpawnResult
} from '../providers/types'
import { SessionNotFoundError, TerminalSessionOwnerUnverifiedError } from './daemon-errors'

export type DaemonSessionOwnerResolution<T extends IPtyProvider> =
  | { kind: 'owner'; provider: T }
  | { kind: 'absent' }
  | { kind: 'unknown' }

type ProviderInventory<T> = { provider: T; processes: PtyProcessInfo[] | null }

type OwnerInventory<T extends IPtyProvider> = {
  candidatesBySessionId: Map<string, { provider: T; process: PtyProcessInfo }[]>
  complete: boolean
  epoch: number
}

const OWNER_RESOLUTION_TIMEOUT_MS = 2_000
const OWNER_INVENTORY_CACHE_MS = 1_000
const FAILED_PROVIDER_COOLDOWN_MS = 1_000

function assertClientConnected(signal: PtySpawnOptions['signal']): void {
  if (signal?.aborted) {
    throw new Error('client_disconnected')
  }
}

export class DaemonSessionOwnerResolver<T extends IPtyProvider> {
  private inventoryInFlight: Promise<OwnerInventory<T>> | null = null
  private cachedInventory: { value: OwnerInventory<T>; expiresAt: number } | null = null
  private readonly failedProviderCooldowns = new Map<T, number>()
  private readonly routeIncarnations = new Map<string, string | undefined>()
  private epoch = 0

  constructor(
    private readonly providers: readonly T[],
    private readonly routes: Map<string, IPtyProvider>
  ) {}

  invalidateProvider(provider: T): void {
    this.epoch += 1
    this.inventoryInFlight = null
    this.cachedInventory = null
    this.failedProviderCooldowns.clear()
    for (const [sessionId, routed] of this.routes) {
      if (routed === provider) {
        this.routes.delete(sessionId)
        this.routeIncarnations.delete(sessionId)
      }
    }
  }

  async spawnAttachOnly(opts: PtySpawnOptions & { sessionId: string }): Promise<PtySpawnResult> {
    assertClientConnected(opts.signal)
    const routed = this.providers.find((provider) => provider === this.routes.get(opts.sessionId))
    const direct = routed ?? (this.providers.length === 1 ? this.providers[0] : undefined)
    const routedIncarnation = this.routeIncarnations.get(opts.sessionId)
    const routeNeedsAuthoritativeResolution =
      direct &&
      routed &&
      opts.expectedIncarnationIsAuthoritative === true &&
      routedIncarnation !== opts.expectedIncarnationId
    if (direct && !routeNeedsAuthoritativeResolution) {
      try {
        const result = await direct.spawn(opts)
        if (
          !result.exitedBeforeSpawnReply &&
          result.id === opts.sessionId &&
          result.isReattach === true
        ) {
          this.recordRoute(result.id, direct, result.incarnationId)
        }
        return result
      } catch (error) {
        if (!(error instanceof SessionNotFoundError)) {
          throw error
        }
        if (this.providers.length === 1) {
          throw error
        }
        if (routed && this.routes.get(opts.sessionId) === routed) {
          this.forgetRoute(opts.sessionId, routed)
        }
      }
    }

    assertClientConnected(opts.signal)
    const resolution = await this.resolve(
      opts.sessionId,
      opts.expectedIncarnationId,
      opts.expectedIncarnationIsAuthoritative
    )
    assertClientConnected(opts.signal)
    if (resolution.kind === 'unknown') {
      throw new TerminalSessionOwnerUnverifiedError(opts.sessionId)
    }
    if (resolution.kind === 'absent') {
      throw new SessionNotFoundError(opts.sessionId)
    }
    try {
      const result = await resolution.provider.spawn(opts)
      if (
        !result.exitedBeforeSpawnReply &&
        result.id === opts.sessionId &&
        result.isReattach === true
      ) {
        this.recordRoute(result.id, resolution.provider, result.incarnationId)
      }
      return result
    } catch (error) {
      if (error instanceof SessionNotFoundError && this.providers.length > 1) {
        throw new TerminalSessionOwnerUnverifiedError(opts.sessionId)
      }
      throw error
    }
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
        this.routes.delete(sessionId)
        this.routeIncarnations.delete(sessionId)
      }
    }
    const inventory = await this.inventory(false)
    if (inventory.epoch !== this.epoch) {
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
    expectedIncarnationIsAuthoritative = false
  ): Promise<DaemonSessionOwnerResolution<T>> {
    const inventory = await this.inventory()
    if (inventory.epoch !== this.epoch) {
      return { kind: 'unknown' }
    }
    const resolution = this.resolveInventory(
      inventory,
      sessionId,
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

  async discoverRoutes(): Promise<void> {
    await this.inventory()
    this.failedProviderCooldowns.clear()
    this.cachedInventory = null
  }

  recordRoute(sessionId: string, provider: T, incarnationId?: string): void {
    this.routes.set(sessionId, provider)
    this.routeIncarnations.set(sessionId, incarnationId)
  }

  forgetRoute(sessionId: string, provider?: T): void {
    if (provider && this.routes.get(sessionId) !== provider) {
      return
    }
    this.routes.delete(sessionId)
    this.routeIncarnations.delete(sessionId)
    this.cachedInventory = null
  }

  private resolveInventory(
    inventory: OwnerInventory<T>,
    sessionId: string,
    expectedIncarnationId?: string,
    expectedIncarnationIsAuthoritative = false
  ): DaemonSessionOwnerResolution<T> {
    const candidates = inventory.candidatesBySessionId.get(sessionId) ?? []
    const providers = new Set(candidates.map(({ provider }) => provider))
    const exactProviders = new Set(
      candidates
        .filter(({ process }) => process.incarnationId === expectedIncarnationId)
        .map(({ provider }) => provider)
    )
    const exactProvider =
      expectedIncarnationId && exactProviders.size === 1
        ? exactProviders.values().next().value
        : undefined
    const soleProvider = providers.size === 1 ? providers.values().next().value : undefined
    const provider =
      (exactProvider && (inventory.complete || expectedIncarnationIsAuthoritative)
        ? exactProvider
        : undefined) ??
      (!expectedIncarnationIsAuthoritative && inventory.complete ? soleProvider : undefined)
    if (provider) {
      const process = candidates.find((candidate) => candidate.provider === provider)?.process
      this.recordRoute(sessionId, provider, process?.incarnationId)
      return { kind: 'owner', provider }
    }
    if (!inventory.complete || providers.size > 1 || this.providers.length !== 1) {
      return { kind: 'unknown' }
    }
    return { kind: 'absent' }
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
    const candidatesBySessionId = new Map<string, { provider: T; process: PtyProcessInfo }[]>()
    let complete = true
    for (const entry of entries) {
      if (!entry.processes) {
        complete = false
        continue
      }
      for (const process of entry.processes) {
        const candidates = candidatesBySessionId.get(process.id) ?? []
        candidates.push({ provider: entry.provider, process })
        candidatesBySessionId.set(process.id, candidates)
      }
    }
    if (complete && epoch === this.epoch) {
      for (const [sessionId, candidates] of candidatesBySessionId) {
        const providers = new Set(candidates.map(({ provider }) => provider))
        if (providers.size === 1) {
          const provider = providers.values().next().value!
          const process = candidates.find((candidate) => candidate.provider === provider)?.process
          this.recordRoute(sessionId, provider, process?.incarnationId)
        } else {
          this.forgetRoute(sessionId)
        }
      }
    }
    return { candidatesBySessionId, complete, epoch }
  }
}

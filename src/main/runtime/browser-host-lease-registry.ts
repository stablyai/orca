import { randomUUID } from 'node:crypto'

const MAX_GENERATION = 0xffff_ffff

export type RuntimeBrowserPlacement =
  | { kind: 'server' }
  | {
      kind: 'client'
      browserHostClientId: string
      browserHostGeneration: number
      pageHostGeneration: number
    }

export type BrowserHostLease = Readonly<{
  authorityRuntimeId: string
  authorityEpoch: string
  browserHostClientId: string
  browserHostGeneration: number
  connectionId: string
  pairedDeviceId: string
  hostCapabilities: readonly string[]
}>

export type BrowserHostLeaseIdentity = Pick<
  BrowserHostLease,
  'authorityEpoch' | 'browserHostClientId' | 'browserHostGeneration' | 'pairedDeviceId'
>

type FenceReason = 'replaced' | 'released' | 'lease_released' | 'lease_replaced'

type Fence = {
  promise: Promise<FenceReason>
  resolve: (reason: FenceReason) => void
}

type LeaseState = {
  token: symbol
  lease: BrowserHostLease
  fence: Fence
  routes: Set<RouteState>
}

type RouteState = {
  token: symbol
  lease: LeaseState
  key: string
  tunnelGeneration: number
  fence: Fence
}

export type BrowserHostLeaseHandle = Readonly<{
  lease: BrowserHostLease
  whenFenced: Promise<FenceReason>
  release: () => void
}>

export type BrowserTunnelLeaseHandle = Readonly<{
  tunnelGeneration: number
  whenFenced: Promise<FenceReason>
  release: () => void
}>

export class BrowserHostLeaseRegistry {
  readonly authorityRuntimeId: string
  readonly authorityEpoch: string
  private nextHostGeneration = 1
  private nextTunnelGeneration = 1
  private readonly nextPageGenerationByPageId = new Map<string, number>()
  private readonly leasesByClientId = new Map<string, LeaseState>()
  private readonly routesByKey = new Map<string, RouteState>()
  private readonly placementsByPageId = new Map<string, RuntimeBrowserPlacement>()

  constructor(options: { authorityRuntimeId: string; authorityEpoch?: string }) {
    this.authorityRuntimeId = options.authorityRuntimeId
    this.authorityEpoch = options.authorityEpoch ?? randomUUID()
  }

  attach(input: {
    browserHostClientId: string
    connectionId: string
    pairedDeviceId: string
    hostCapabilities: readonly string[]
  }): BrowserHostLeaseHandle {
    const existing = this.leasesByClientId.get(input.browserHostClientId)
    if (existing) {
      if (existing.lease.pairedDeviceId !== input.pairedDeviceId) {
        throw new Error('browser_host_identity_conflict')
      }
    }
    const generation = this.takeGeneration('host')
    if (existing) {
      this.fenceLease(existing, 'replaced')
    }
    const state: LeaseState = {
      token: Symbol(input.browserHostClientId),
      lease: Object.freeze({
        authorityRuntimeId: this.authorityRuntimeId,
        authorityEpoch: this.authorityEpoch,
        browserHostClientId: input.browserHostClientId,
        browserHostGeneration: generation,
        connectionId: input.connectionId,
        pairedDeviceId: input.pairedDeviceId,
        hostCapabilities: Object.freeze([...input.hostCapabilities])
      }),
      fence: createFence(),
      routes: new Set()
    }
    this.leasesByClientId.set(input.browserHostClientId, state)
    return {
      lease: state.lease,
      whenFenced: state.fence.promise,
      release: () => this.releaseLease(state)
    }
  }

  select(browserHostClientId?: string): BrowserHostLease {
    if (browserHostClientId) {
      const exact = this.leasesByClientId.get(browserHostClientId)
      if (!exact) {
        throw new Error('browser_host_unavailable')
      }
      return exact.lease
    }
    if (this.leasesByClientId.size === 0) {
      throw new Error('browser_host_unavailable')
    }
    if (this.leasesByClientId.size > 1) {
      throw new Error('browser_host_ambiguous')
    }
    return this.leasesByClientId.values().next().value!.lease
  }

  requireLease(identity: BrowserHostLeaseIdentity): BrowserHostLease {
    if (identity.authorityEpoch !== this.authorityEpoch) {
      throw new Error('browser_host_lease_stale')
    }
    const state = this.leasesByClientId.get(identity.browserHostClientId)
    if (!state) {
      throw new Error('browser_host_lease_required')
    }
    if (
      state.lease.browserHostGeneration !== identity.browserHostGeneration ||
      state.lease.pairedDeviceId !== identity.pairedDeviceId
    ) {
      throw new Error('browser_host_lease_stale')
    }
    return state.lease
  }

  placeServerPage(browserPageId: string): RuntimeBrowserPlacement {
    const placement = Object.freeze({ kind: 'server' as const })
    this.placementsByPageId.set(browserPageId, placement)
    return placement
  }

  placeClientPage(browserPageId: string, browserHostClientId?: string): RuntimeBrowserPlacement {
    const lease = this.select(browserHostClientId)
    const pageHostGeneration = this.takePageGeneration(browserPageId)
    const placement = Object.freeze({
      kind: 'client' as const,
      browserHostClientId: lease.browserHostClientId,
      browserHostGeneration: lease.browserHostGeneration,
      pageHostGeneration
    })
    this.placementsByPageId.set(browserPageId, placement)
    return placement
  }

  getPlacement(browserPageId: string): RuntimeBrowserPlacement | undefined {
    return this.placementsByPageId.get(browserPageId)
  }

  openTunnel(
    identity: BrowserHostLeaseIdentity & { executionHostKey: string }
  ): BrowserTunnelLeaseHandle {
    this.requireLease(identity)
    const lease = this.leasesByClientId.get(identity.browserHostClientId)!
    const key = `${identity.browserHostClientId}\u0000${identity.executionHostKey}`
    const existing = this.routesByKey.get(key)
    const tunnelGeneration = this.takeGeneration('tunnel')
    if (existing) {
      this.fenceRoute(existing, 'replaced')
    }
    const state: RouteState = {
      token: Symbol(key),
      lease,
      key,
      tunnelGeneration,
      fence: createFence()
    }
    lease.routes.add(state)
    this.routesByKey.set(key, state)
    return {
      tunnelGeneration: state.tunnelGeneration,
      whenFenced: state.fence.promise,
      release: () => this.fenceRoute(state, 'released')
    }
  }

  private releaseLease(state: LeaseState): void {
    this.fenceLease(state, 'lease_released')
  }

  private fenceLease(state: LeaseState, reason: FenceReason): void {
    if (this.leasesByClientId.get(state.lease.browserHostClientId)?.token !== state.token) {
      return
    }
    this.leasesByClientId.delete(state.lease.browserHostClientId)
    for (const route of state.routes) {
      this.fenceRoute(route, reason === 'replaced' ? 'lease_replaced' : 'lease_released')
    }
    state.fence.resolve(reason)
  }

  private fenceRoute(state: RouteState, reason: FenceReason): void {
    state.lease.routes.delete(state)
    if (this.routesByKey.get(state.key)?.token === state.token) {
      this.routesByKey.delete(state.key)
    }
    state.fence.resolve(reason)
  }

  private takeGeneration(kind: 'host' | 'tunnel'): number {
    const value = kind === 'host' ? this.nextHostGeneration : this.nextTunnelGeneration
    if (value > MAX_GENERATION) {
      throw new Error(`browser_${kind}_generation_exhausted`)
    }
    if (kind === 'host') {
      this.nextHostGeneration += 1
    } else {
      this.nextTunnelGeneration += 1
    }
    return value
  }

  private takePageGeneration(browserPageId: string): number {
    const value = this.nextPageGenerationByPageId.get(browserPageId) ?? 1
    if (value > MAX_GENERATION) {
      throw new Error('browser_page_generation_exhausted')
    }
    this.nextPageGenerationByPageId.set(browserPageId, value + 1)
    return value
  }
}

const registries = new WeakMap<object, BrowserHostLeaseRegistry>()

export function getBrowserHostLeaseRegistry(runtime: {
  getRuntimeId(): string
}): BrowserHostLeaseRegistry {
  let registry = registries.get(runtime)
  if (!registry) {
    registry = new BrowserHostLeaseRegistry({ authorityRuntimeId: runtime.getRuntimeId() })
    registries.set(runtime, registry)
  }
  return registry
}

function createFence(): Fence {
  let settled = false
  let settle = (_reason: FenceReason): void => {}
  const promise = new Promise<FenceReason>((resolve) => {
    settle = resolve
  })
  return {
    promise,
    resolve: (reason) => {
      if (settled) {
        return
      }
      settled = true
      settle(reason)
    }
  }
}

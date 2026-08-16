import { randomUUID } from 'node:crypto'
import { BrowserExecutionHostGrantRegistry } from './browser-execution-host-grant-registry'
import {
  BrowserHostPagePlacementRegistry,
  type BrowserClientPageAuthority,
  type BrowserPageRetirement,
  type RuntimeBrowserClientPlacement,
  type RuntimeBrowserPlacement
} from './browser-host-page-placement'
import {
  createBrowserHostFence,
  type BrowserHostFence,
  type BrowserHostFenceReason
} from './browser-host-lease-fence'
import {
  BROWSER_HOST_WEBVIEW_CAPABILITY,
  selectBrowserHostLease
} from './browser-host-capability-selection'

const MAX_GENERATION = 0xffff_ffff
const MAX_BROWSER_HOSTS_PER_CONNECTION = 1
// Why: tolerate brief desktop restart/update overlap while keeping one paired identity bounded.
const MAX_BROWSER_HOSTS_PER_PAIRED_DEVICE = 4

export type { BrowserPageRetirement, RuntimeBrowserPlacement } from './browser-host-page-placement'

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

type LeaseState = {
  token: symbol
  lease: BrowserHostLease
  fence: BrowserHostFence
  routes: Set<RouteState>
  executionHostGrants: BrowserExecutionHostGrantRegistry
}

type RouteState = {
  token: symbol
  lease: LeaseState
  key: string
  tunnelGeneration: number
  fence: BrowserHostFence
  releaseGrantLink?: () => void
}

export type BrowserHostLeaseHandle = Readonly<{
  lease: BrowserHostLease
  whenFenced: Promise<BrowserHostFenceReason>
  release: () => void
}>

export type BrowserTunnelLeaseHandle = Readonly<{
  tunnelGeneration: number
  whenFenced: Promise<BrowserHostFenceReason>
  release: () => void
}>

export class BrowserHostLeaseRegistry {
  readonly authorityRuntimeId: string
  readonly authorityEpoch: string
  private nextHostGeneration = 1
  private nextTunnelGeneration = 1
  private readonly leasesByClientId = new Map<string, LeaseState>()
  private readonly routesByKey = new Map<string, RouteState>()
  private readonly pagePlacements: BrowserHostPagePlacementRegistry

  constructor(options: { authorityRuntimeId: string; authorityEpoch?: string }) {
    this.authorityRuntimeId = options.authorityRuntimeId
    this.authorityEpoch = options.authorityEpoch ?? randomUUID()
    this.pagePlacements = new BrowserHostPagePlacementRegistry({
      authorityRuntimeId: this.authorityRuntimeId,
      authorityEpoch: this.authorityEpoch
    })
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
    this.assertLeaseAdmission(input, existing)
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
      fence: createBrowserHostFence(),
      routes: new Set(),
      executionHostGrants: new BrowserExecutionHostGrantRegistry()
    }
    this.leasesByClientId.set(input.browserHostClientId, state)
    return {
      lease: state.lease,
      whenFenced: state.fence.promise,
      release: () => this.releaseLease(state)
    }
  }

  select(
    browserHostClientId?: string,
    requiredCapabilities: readonly string[] = []
  ): BrowserHostLease {
    return selectBrowserHostLease(this.leasesByClientId, browserHostClientId, requiredCapabilities)
  }

  requireLease(identity: BrowserHostLeaseIdentity): BrowserHostLease {
    return this.requireLeaseState(identity).lease
  }

  private requireLeaseState(identity: BrowserHostLeaseIdentity): LeaseState {
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
    return state
  }

  grantExecutionHost(identity: BrowserHostLeaseIdentity, executionHostKey: string) {
    return this.requireLeaseState(identity).executionHostGrants.grant(executionHostKey)
  }

  requireExecutionHost(identity: BrowserHostLeaseIdentity, executionHostKey: string): void {
    this.requireLeaseState(identity).executionHostGrants.require(executionHostKey)
  }

  linkExecutionHostGrant(
    identity: BrowserHostLeaseIdentity,
    executionHostKey: string,
    onRevoked: () => void
  ): () => void {
    return this.requireLeaseState(identity).executionHostGrants.link(executionHostKey, onRevoked)
  }

  placeServerPage(browserPageId: string): RuntimeBrowserPlacement {
    return this.pagePlacements.placeServerPage(browserPageId)
  }

  placeClientPage(
    browserPageId: string,
    browserHostClientId?: string,
    requiredCapabilities: readonly string[] = []
  ): RuntimeBrowserPlacement {
    this.pagePlacements.assertPlacementAdmission(browserPageId)
    const lease = this.select(browserHostClientId, [
      BROWSER_HOST_WEBVIEW_CAPABILITY,
      ...requiredCapabilities
    ])
    return this.pagePlacements.placeClientPage(browserPageId, {
      browserHostClientId: lease.browserHostClientId,
      browserHostGeneration: lease.browserHostGeneration
    })
  }

  requireClientPage(authority: BrowserClientPageAuthority): RuntimeBrowserClientPlacement {
    const placement = this.pagePlacements.requireClientPage(authority)
    const lease = this.leasesByClientId.get(authority.browserHostClientId)
    if (!lease) {
      throw new Error('browser_host_lease_required')
    }
    if (lease.lease.browserHostGeneration !== authority.browserHostGeneration) {
      throw new Error('browser_host_lease_stale')
    }
    return placement
  }

  getPlacement(browserPageId: string): RuntimeBrowserPlacement | undefined {
    return this.pagePlacements.getPlacement(browserPageId)
  }

  beginPageRetirement(
    browserPageId: string,
    expected: RuntimeBrowserPlacement
  ): BrowserPageRetirement {
    return this.pagePlacements.beginPageRetirement(browserPageId, expected)
  }

  cancelPageRetirement(retirement: BrowserPageRetirement): boolean {
    return this.pagePlacements.cancelPageRetirement(retirement)
  }

  completePageRetirement(retirement: BrowserPageRetirement): boolean {
    return this.pagePlacements.completePageRetirement(retirement)
  }

  openTunnel(
    identity: BrowserHostLeaseIdentity & { executionHostKey: string },
    options?: { requireExecutionHostGrant?: boolean }
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
      fence: createBrowserHostFence()
    }
    if (options?.requireExecutionHostGrant) {
      state.releaseGrantLink = lease.executionHostGrants.link(identity.executionHostKey, () =>
        this.fenceRoute(state, 'released')
      )
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

  private assertLeaseAdmission(
    input: { connectionId: string; pairedDeviceId: string },
    replacement: LeaseState | undefined
  ): void {
    let connectionLeases = 0
    let deviceLeases = 0
    for (const state of this.leasesByClientId.values()) {
      if (state === replacement) {
        continue
      }
      if (state.lease.connectionId === input.connectionId) {
        connectionLeases += 1
      }
      if (state.lease.pairedDeviceId === input.pairedDeviceId) {
        deviceLeases += 1
      }
    }
    if (connectionLeases >= MAX_BROWSER_HOSTS_PER_CONNECTION) {
      throw new Error('browser_host_connection_capacity')
    }
    if (deviceLeases >= MAX_BROWSER_HOSTS_PER_PAIRED_DEVICE) {
      throw new Error('browser_host_device_capacity')
    }
  }

  private fenceLease(state: LeaseState, reason: BrowserHostFenceReason): void {
    if (this.leasesByClientId.get(state.lease.browserHostClientId)?.token !== state.token) {
      return
    }
    this.leasesByClientId.delete(state.lease.browserHostClientId)
    for (const route of state.routes) {
      this.fenceRoute(route, reason === 'replaced' ? 'lease_replaced' : 'lease_released')
    }
    state.executionHostGrants.clear()
    state.fence.resolve(reason)
  }

  private fenceRoute(state: RouteState, reason: BrowserHostFenceReason): void {
    state.releaseGrantLink?.()
    state.releaseGrantLink = undefined
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

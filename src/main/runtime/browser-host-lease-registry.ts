import { randomUUID } from 'node:crypto'
import type {
  BrowserClientHostedPageInventory,
  BrowserClientHostCommandEvent,
  BrowserClientHostCommandResult
} from '../../shared/browser-client-host-protocol'
import { BrowserHostCommandLedger } from './browser-host-command-ledger'
import type { BrowserHostCommandResultParams } from './browser-host-command-state'
import {
  assertBrowserHostLeaseAdmission,
  requireBrowserHostCommandResultLedger,
  type BrowserHostCommandResultIdentity,
  type BrowserHostLease,
  type BrowserHostLeaseHandle,
  type BrowserHostLeaseIdentity,
  type BrowserHostLeaseState,
  type BrowserHostRouteState,
  type BrowserTunnelLeaseHandle
} from './browser-host-lease-records'
import { BrowserExecutionHostGrantRegistry } from './browser-execution-host-grant-registry'
import { retireClientPageCommandLedger } from './browser-host-command-retirement'
import { BrowserHostGenerationCounter } from './browser-host-generation-counter'
import {
  BrowserHostPagePlacementRegistry,
  type BrowserClientPageAuthority,
  type BrowserPageRetirement,
  type RuntimeBrowserClientPlacement,
  type RuntimeBrowserPlacement
} from './browser-host-page-placement'
import { createBrowserHostFence, type BrowserHostFenceReason } from './browser-host-lease-fence'
import { fenceBrowserHostLease, fenceBrowserHostRoute } from './browser-host-lease-fencing'
import {
  BROWSER_HOST_WEBVIEW_CAPABILITY,
  selectBrowserHostLease
} from './browser-host-capability-selection'
import { snapshotBrowserHostPageInventory } from './browser-host-page-inventory-snapshot'

export class BrowserHostLeaseRegistry {
  readonly authorityRuntimeId: string
  readonly authorityEpoch: string
  private readonly generations = new BrowserHostGenerationCounter()
  private readonly leasesByClientId = new Map<string, BrowserHostLeaseState>()
  private readonly routesByKey = new Map<string, BrowserHostRouteState>()
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
    pageCommandProtocolVersion?: 1
    pageInventoryProtocolVersion?: 1
    pageInventory?: readonly BrowserClientHostedPageInventory[]
  }): BrowserHostLeaseHandle {
    const pageInventory = snapshotBrowserHostPageInventory(input)
    const existing = this.leasesByClientId.get(input.browserHostClientId)
    if (existing) {
      if (existing.lease.pairedDeviceId !== input.pairedDeviceId) {
        throw new Error('browser_host_identity_conflict')
      }
    }
    assertBrowserHostLeaseAdmission(this.leasesByClientId.values(), input, existing)
    const generation = this.generations.take('host')
    if (existing) {
      this.fenceLease(existing, 'replaced')
    }
    const state: BrowserHostLeaseState = {
      token: Symbol(input.browserHostClientId),
      lease: Object.freeze({
        authorityRuntimeId: this.authorityRuntimeId,
        authorityEpoch: this.authorityEpoch,
        browserHostClientId: input.browserHostClientId,
        browserHostGeneration: generation,
        connectionId: input.connectionId,
        pairedDeviceId: input.pairedDeviceId,
        hostCapabilities: Object.freeze([...input.hostCapabilities]),
        ...(input.pageCommandProtocolVersion ? { pageCommandProtocolVersion: 1 as const } : {}),
        ...(pageInventory
          ? {
              pageInventoryProtocolVersion: 1 as const,
              pageInventory
            }
          : {})
      }),
      fence: createBrowserHostFence(),
      routes: new Set(),
      executionHostGrants: new BrowserExecutionHostGrantRegistry()
    }
    if (input.pageCommandProtocolVersion) {
      state.commandLedger = new BrowserHostCommandLedger({
        authority: {
          authorityRuntimeId: state.lease.authorityRuntimeId,
          authorityEpoch: state.lease.authorityEpoch,
          browserHostClientId: state.lease.browserHostClientId,
          browserHostGeneration: state.lease.browserHostGeneration,
          pageCommandProtocolVersion: 1
        }
      })
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

  private requireLeaseState(identity: BrowserHostLeaseIdentity): BrowserHostLeaseState {
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

  attachCommandDelivery(
    identity: BrowserHostLeaseIdentity,
    delivery: (event: BrowserClientHostCommandEvent) => void
  ): () => void {
    const ledger = this.requireLeaseState(identity).commandLedger
    if (!ledger) {
      throw new Error('browser_host_command_protocol_required')
    }
    return ledger.attach(delivery)
  }

  issueClientPageCommand(
    authority: BrowserClientPageAuthority,
    command: BrowserClientHostCommandEvent['command']
  ): {
    event: BrowserClientHostCommandEvent
    result: Promise<BrowserClientHostCommandResult>
  } {
    this.requireClientPage(authority)
    const state = this.leasesByClientId.get(authority.browserHostClientId)
    const ledger = state?.commandLedger
    if (
      !state ||
      state.lease.browserHostGeneration !== authority.browserHostGeneration ||
      !ledger
    ) {
      throw new Error('browser_host_command_protocol_required')
    }
    if (command.type === 'createPage') {
      state.executionHostGrants.require(command.executionHostKey)
    }
    return ledger.issue({
      browserPageId: authority.browserPageId,
      pageHostGeneration: authority.pageHostGeneration,
      command
    })
  }

  settleClientPageCommand(
    identity: BrowserHostCommandResultIdentity,
    params: BrowserHostCommandResultParams
  ): boolean {
    const state = this.requireLeaseState(identity)
    const ledger = requireBrowserHostCommandResultLedger(state, identity)
    this.requireClientPage(params)
    return ledger.settle(params)
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
    return this.pagePlacements.completePageRetirement(retirement, () =>
      retireClientPageCommandLedger(this.leasesByClientId, retirement)
    )
  }

  openTunnel(
    identity: BrowserHostLeaseIdentity & { executionHostKey: string },
    options?: { requireExecutionHostGrant?: boolean }
  ): BrowserTunnelLeaseHandle {
    this.requireLease(identity)
    const lease = this.leasesByClientId.get(identity.browserHostClientId)!
    const key = `${identity.browserHostClientId}\u0000${identity.executionHostKey}`
    const existing = this.routesByKey.get(key)
    const tunnelGeneration = this.generations.take('tunnel')
    if (existing) {
      this.fenceRoute(existing, 'replaced')
    }
    const state: BrowserHostRouteState = {
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

  private releaseLease(state: BrowserHostLeaseState): void {
    this.fenceLease(state, 'lease_released')
  }

  private fenceLease(state: BrowserHostLeaseState, reason: BrowserHostFenceReason): void {
    fenceBrowserHostLease(state, reason, this.leasesByClientId, (route, routeReason) =>
      this.fenceRoute(route, routeReason)
    )
  }

  private fenceRoute(state: BrowserHostRouteState, reason: BrowserHostFenceReason): void {
    fenceBrowserHostRoute(state, reason, this.routesByKey)
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

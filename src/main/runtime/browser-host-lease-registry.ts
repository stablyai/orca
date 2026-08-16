import { randomUUID } from 'node:crypto'
import type {
  BrowserClientHostCommandEvent,
  BrowserClientHostCommandResult
} from '../../shared/browser-client-host-protocol'
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
import { retireClientPageCommandLedger } from './browser-host-command-retirement'
import { BrowserHostGenerationCounter } from './browser-host-generation-counter'
import { assertBrowserHostPageCommandAdmission } from './browser-host-page-command-admission'
import {
  BrowserHostPagePlacementRegistry,
  requireLiveBrowserClientPage,
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
import { BrowserHostPageReconciliationOrchestrator } from './browser-host-page-reconciliation-orchestration'
import type { BrowserHostRuntimePageIntent } from './browser-host-page-reconciliation-plan'
import { BrowserHostLeaseReconnectController } from './browser-host-lease-reconnect'
import {
  assertBrowserHostReconnectNegotiation,
  createBrowserHostLeaseState,
  type BrowserHostLeaseAttachInput
} from './browser-host-lease-attachment'

export class BrowserHostLeaseRegistry {
  readonly authorityRuntimeId: string
  readonly authorityEpoch: string
  private readonly generations = new BrowserHostGenerationCounter()
  private readonly leasesByClientId = new Map<string, BrowserHostLeaseState>()
  private readonly routesByKey = new Map<string, BrowserHostRouteState>()
  private readonly pagePlacements: BrowserHostPagePlacementRegistry
  private readonly pageReconciliations: BrowserHostPageReconciliationOrchestrator
  private readonly reconnects: BrowserHostLeaseReconnectController

  constructor(options: {
    authorityRuntimeId: string
    authorityEpoch?: string
    reconnectGraceMs?: number
  }) {
    this.authorityRuntimeId = options.authorityRuntimeId
    this.authorityEpoch = options.authorityEpoch ?? randomUUID()
    this.pagePlacements = new BrowserHostPagePlacementRegistry({
      authorityRuntimeId: this.authorityRuntimeId,
      authorityEpoch: this.authorityEpoch
    })
    this.pageReconciliations = new BrowserHostPageReconciliationOrchestrator(
      this,
      this.pagePlacements
    )
    this.reconnects = new BrowserHostLeaseReconnectController({
      graceMs: options.reconnectGraceMs ?? 15_000,
      leasesByClientId: this.leasesByClientId,
      fenceReconciliation: (state) => this.pageReconciliations.fence(state),
      fenceLease: (state, reason) => this.fenceLease(state, reason),
      fenceRoute: (state, reason) => this.fenceRoute(state, reason)
    })
  }

  attach(input: BrowserHostLeaseAttachInput): BrowserHostLeaseHandle {
    const pageInventory = snapshotBrowserHostPageInventory(input)
    assertBrowserHostReconnectNegotiation(input)
    const existing = this.leasesByClientId.get(input.browserHostClientId)
    if (existing && existing.lease.pairedDeviceId !== input.pairedDeviceId) {
      throw new Error('browser_host_identity_conflict')
    }
    assertBrowserHostLeaseAdmission(this.leasesByClientId.values(), input, existing)
    const restored = existing ? this.reconnects.restore(existing, input, pageInventory) : undefined
    if (restored && existing) {
      this.pageReconciliations.observeInventory(existing)
      return restored
    }
    const generation = this.generations.take('host')
    if (existing) {
      this.fenceLease(existing, 'replaced')
    }
    const state = createBrowserHostLeaseState({
      authorityRuntimeId: this.authorityRuntimeId,
      authorityEpoch: this.authorityEpoch,
      generation,
      input,
      pageInventory
    })
    this.leasesByClientId.set(input.browserHostClientId, state)
    return this.reconnects.createHandle(state)
  }

  select(
    browserHostClientId?: string,
    requiredCapabilities: readonly string[] = []
  ): BrowserHostLease {
    return selectBrowserHostLease(
      new Map([...this.leasesByClientId].filter(([, state]) => state.status === 'active')),
      browserHostClientId,
      requiredCapabilities
    )
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
    if (state.status !== 'active') {
      throw new Error('browser_host_lease_reconnecting')
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
    return requireLiveBrowserClientPage(this.pagePlacements, this.leasesByClientId, authority)
  }

  reconcileClientPages(
    identity: BrowserHostLeaseIdentity,
    intents: readonly BrowserHostRuntimePageIntent[],
    options: { maxConcurrency?: number; actionTimeoutMs?: number; signal?: AbortSignal } = {}
  ) {
    return this.pageReconciliations.reconcile(this.requireLeaseState(identity), intents, options)
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
    assertBrowserHostPageCommandAdmission(state.lease, command, (executionHostKey) =>
      state.executionHostGrants.require(executionHostKey)
    )
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
    if (!ledger.isReconciliationResult(params)) {
      this.requireClientPage(params)
    }
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

  private fenceLease(state: BrowserHostLeaseState, reason: BrowserHostFenceReason): void {
    this.reconnects.clear(state)
    if (this.leasesByClientId.get(state.lease.browserHostClientId)?.token !== state.token) {
      return
    }
    this.pageReconciliations.fence(state)
    this.pagePlacements.fenceClientHostPlacements({
      browserHostClientId: state.lease.browserHostClientId,
      browserHostGeneration: state.lease.browserHostGeneration
    })
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

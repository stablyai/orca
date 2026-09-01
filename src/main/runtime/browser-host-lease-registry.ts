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
  type BrowserTunnelLeaseHandle
} from './browser-host-lease-records'
import { BrowserHostGenerationCounter } from './browser-host-generation-counter'
import { issueBrowserHostClientPageCommand } from './browser-host-client-page-command-issue'
import {
  BrowserHostPagePlacementRegistry,
  type BrowserClientPageAuthority,
  type BrowserPageRetirement,
  type RuntimeBrowserClientPlacement,
  type RuntimeBrowserPlacement
} from './browser-host-page-placement'
import { requireLiveBrowserClientPage } from './browser-host-page-authority'
import type { BrowserHostFenceReason } from './browser-host-lease-fence'
import { dispatchBrowserHostLeaseFence } from './browser-host-lease-fence-dispatch'
import {
  BROWSER_HOST_WEBVIEW_CAPABILITY,
  selectBrowserHostLease
} from './browser-host-capability-selection'
import {
  createBrowserHostClientPage,
  type BrowserClientPageExecutionHostGrant,
  type BrowserHostClientPageCreateOptions
} from './browser-host-client-page-creation'
import { adoptBrowserHostClientPages } from './browser-host-client-page-adoption'
import { snapshotBrowserHostPageInventory } from './browser-host-page-inventory-snapshot'
import { BrowserHostPageReconciliationOrchestrator } from './browser-host-page-reconciliation-orchestration'
import type { BrowserHostRuntimePageIntent } from './browser-host-page-reconciliation-plan'
import { BrowserHostLeaseReconnectController } from './browser-host-lease-reconnect'
import {
  assertBrowserHostReconnectNegotiation,
  createBrowserHostLeaseState,
  type BrowserHostLeaseAttachInput
} from './browser-host-lease-attachment'
import { BrowserHostTunnelRegistry } from './browser-host-tunnel-registry'
import { requireBrowserHostLeaseState } from './browser-host-lease-state-resolution'
import { requireBrowserClientPageConnection } from './browser-host-client-page-connection'
import { completeBrowserHostPageRetirement } from './browser-host-page-retirement-completion'
import { placeBrowserHostClientPage } from './browser-host-client-page-placement'

export class BrowserHostLeaseRegistry {
  readonly authorityRuntimeId: string
  readonly authorityEpoch: string
  private readonly generations = new BrowserHostGenerationCounter()
  private readonly leasesByClientId = new Map<string, BrowserHostLeaseState>()
  private readonly tunnels = new BrowserHostTunnelRegistry()
  private readonly clientPageExecutionHostGrants = new Map<
    string,
    BrowserClientPageExecutionHostGrant
  >()
  private readonly pagePlacements: BrowserHostPagePlacementRegistry
  private readonly pageReconciliations: BrowserHostPageReconciliationOrchestrator
  private readonly reconnects: BrowserHostLeaseReconnectController

  constructor(
    private readonly options: {
      authorityRuntimeId: string
      authorityEpoch?: string
      reconnectGraceMs?: number
      /**
       * Called when a client page stops being reachable -- retired, or fenced with its lease. Runs
       * even when the client transport is already gone, so runtime-side per-page state (staged
       * download transfers) is not stranded.
       */
      onClientPageReleased?: (browserPageId: string) => void
      /**
       * Called when a lease fence takes a client page's placement away. The page itself outlives
       * the host that placed it, so this hands the runtime its record back to retain rather than
       * to drop -- a host returning under the same identity recovers it from there.
       */
      onClientPageFenced?: (browserPageId: string, placement: RuntimeBrowserClientPlacement) => void
    }
  ) {
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
      fenceRoute: (state, reason) => this.tunnels.fence(state, reason)
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

  requireClientPageConnection(input: {
    browserPageId: string
    placement: RuntimeBrowserClientPlacement
    pairedDeviceId: string
    connectionId: string
  }): RuntimeBrowserClientPlacement {
    return requireBrowserClientPageConnection(input, {
      authorityRuntimeId: this.authorityRuntimeId,
      authorityEpoch: this.authorityEpoch,
      leasesByClientId: this.leasesByClientId,
      pagePlacements: this.pagePlacements
    })
  }

  private requireLeaseState(identity: BrowserHostLeaseIdentity): BrowserHostLeaseState {
    return requireBrowserHostLeaseState(this.authorityEpoch, this.leasesByClientId, identity)
  }

  grantExecutionHost(identity: BrowserHostLeaseIdentity, executionHostKey: string) {
    return this.tunnels.grantExecutionHost(this.requireLeaseState(identity), executionHostKey)
  }

  requireExecutionHost(identity: BrowserHostLeaseIdentity, executionHostKey: string): void {
    this.tunnels.requireExecutionHost(this.requireLeaseState(identity), executionHostKey)
  }

  linkExecutionHostGrant(
    identity: BrowserHostLeaseIdentity,
    executionHostKey: string,
    onRevoked: () => void
  ): () => void {
    return this.tunnels.linkExecutionHostGrant(
      this.requireLeaseState(identity),
      executionHostKey,
      onRevoked
    )
  }

  placeServerPage(browserPageId: string): RuntimeBrowserPlacement {
    return this.pagePlacements.placeServerPage(browserPageId)
  }

  placeClientPage(
    browserPageId: string,
    browserHostClientId?: string,
    requiredCapabilities: readonly string[] = []
  ): RuntimeBrowserPlacement {
    return placeBrowserHostClientPage({
      browserPageId,
      browserHostClientId,
      requiredCapabilities,
      pagePlacements: this.pagePlacements,
      selectLease: (clientId, capabilities) => this.select(clientId, capabilities)
    })
  }

  async createClientPage(
    options: BrowserHostClientPageCreateOptions
  ): Promise<RuntimeBrowserClientPlacement> {
    return createBrowserHostClientPage(options, {
      selectLease: (browserHostClientId, requiredCapabilities) =>
        this.select(browserHostClientId, [
          BROWSER_HOST_WEBVIEW_CAPABILITY,
          ...requiredCapabilities
        ]),
      requireLeaseState: (lease) => this.requireLeaseState(lease),
      pagePlacements: this.pagePlacements,
      executionHostGrants: this.clientPageExecutionHostGrants
    })
  }

  requireClientPage(authority: BrowserClientPageAuthority): RuntimeBrowserClientPlacement {
    return requireLiveBrowserClientPage(this.pagePlacements, this.leasesByClientId, authority)
  }

  adoptClientPages(
    identity: BrowserHostLeaseIdentity,
    intents: readonly BrowserHostRuntimePageIntent[],
    options: { maxConcurrency?: number; actionTimeoutMs?: number; signal?: AbortSignal } = {}
  ): Promise<readonly string[]> {
    return adoptBrowserHostClientPages(intents, options, {
      state: this.requireLeaseState(identity),
      reconciliations: this.pageReconciliations,
      placements: this.pagePlacements,
      executionHostGrants: this.clientPageExecutionHostGrants
    })
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
    return issueBrowserHostClientPageCommand(authority, command, this.leasesByClientId)
  }

  settleClientPageCommand(
    identity: BrowserHostCommandResultIdentity,
    params: BrowserHostCommandResultParams
  ): boolean {
    const state = this.requireLeaseState(identity)
    const ledger = requireBrowserHostCommandResultLedger(state, identity)
    if (!ledger.isUnplacedPageResult(params)) {
      this.requireClientPage(params)
    }
    return ledger.settle(params)
  }

  getPlacement(browserPageId: string): RuntimeBrowserPlacement | undefined {
    return this.pagePlacements.getPlacement(browserPageId)
  }

  getClientPageExecutionHostKey(browserPageId: string): string | undefined {
    const grant = this.clientPageExecutionHostGrants.get(browserPageId)
    return grant && this.pagePlacements.getPlacement(browserPageId) === grant.placement
      ? grant.executionHostKey
      : undefined
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
    return completeBrowserHostPageRetirement(retirement, {
      pagePlacements: this.pagePlacements,
      leasesByClientId: this.leasesByClientId,
      executionHostGrants: this.clientPageExecutionHostGrants,
      onClientPageReleased: this.options.onClientPageReleased
    })
  }

  openTunnel(
    identity: BrowserHostLeaseIdentity & { executionHostKey: string },
    options?: { requireExecutionHostGrant?: boolean }
  ): BrowserTunnelLeaseHandle {
    return this.tunnels.open(this.requireLeaseState(identity), identity.executionHostKey, options)
  }

  private fenceLease(state: BrowserHostLeaseState, reason: BrowserHostFenceReason): void {
    dispatchBrowserHostLeaseFence(state, reason, {
      leasesByClientId: this.leasesByClientId,
      pagePlacements: this.pagePlacements,
      clearReconnect: (fenced) => this.reconnects.clear(fenced),
      fenceReconciliation: (fenced) => this.pageReconciliations.fence(fenced),
      fenceRoute: (route, routeReason) => this.tunnels.fence(route, routeReason),
      releaseFencedPage: (retirement) => this.releaseFencedClientPage(retirement)
    })
  }

  private releaseFencedClientPage(retirement: BrowserPageRetirement): void {
    if (this.completePageRetirement(retirement) && retirement.placement.kind === 'client') {
      this.options.onClientPageFenced?.(retirement.browserPageId, retirement.placement)
    }
  }
}

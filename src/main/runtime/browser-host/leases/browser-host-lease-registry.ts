import type { BrowserHostLegacyPageRecoveryInput } from '../client-pages/browser-host-page-legacy-recovery'
import { createBrowserHostLeaseControllers } from './browser-host-lease-controllers'
import type { BrowserHostLeaseRegistryOptions } from './browser-host-lease-registry-options'
import type { BrowserHostPageInitializationInput } from '../client-pages/browser-host-page-initialization'
import { switchBrowserHostClientProfile } from '../profiles/browser-host-client-profile-switch'
import { randomUUID } from 'node:crypto'
import type { BrowserClientHostCommandEvent } from '../../../../shared/browser/client-hosting/browser-client-host-protocol'
import type { BrowserHostCommandResultParams } from '../commands/browser-host-command-state'
import type {
  BrowserHostCommandResultIdentity,
  BrowserHostLease,
  BrowserHostLeaseHandle,
  BrowserHostLeaseIdentity,
  BrowserHostLeaseState,
  BrowserTunnelLeaseHandle
} from './browser-host-lease-records'
import { BrowserHostGenerationCounter } from './browser-host-generation-counter'
import {
  issueBrowserHostClientPageCommand,
  attachBrowserHostClientCommandDelivery,
  settleBrowserHostClientPageCommand
} from '../commands/browser-host-client-page-command-issue'
import {
  BrowserHostPagePlacementRegistry,
  type BrowserClientPageAuthority,
  type BrowserPageRetirement
} from '../reconciliation/browser-host-page-placement'
import type {
  RuntimeBrowserClientPlacement,
  RuntimeBrowserPlacement
} from '../../../../shared/runtime-browser-placement'
import { requireLiveBrowserClientPage } from '../reconciliation/browser-host-page-authority'
import type { BrowserHostFenceReason } from './browser-host-lease-fence'
import { dispatchBrowserHostLeaseFence } from './browser-host-lease-fence-dispatch'
import { selectActiveBrowserHostLease } from './browser-host-capability-selection'
import {
  createBrowserHostClientPage,
  type BrowserClientPageExecutionHostGrant,
  type BrowserHostClientPageCreateOptions
} from '../client-pages/browser-host-client-page-creation'
import {
  adoptBrowserHostClientPages,
  type BrowserHostClientPageAdoptionOptions
} from '../client-pages/browser-host-client-page-adoption'
import type { BrowserHostRuntimePageIntent } from '../reconciliation/browser-host-page-reconciliation-plan'
import {
  attachBrowserHostLease,
  type BrowserHostLeaseAttachInput
} from './browser-host-lease-attachment'
import { BrowserHostTunnelRegistry } from './browser-host-tunnel-registry'
import { requireBrowserHostLeaseState } from './browser-host-lease-state-resolution'
import {
  requireBrowserClientPageConnection,
  type BrowserClientPageConnectionInput
} from '../client-pages/browser-host-client-page-connection'
import { completeBrowserHostPageRetirement } from '../reconciliation/browser-host-page-retirement-completion'
import {
  placeBrowserHostClientPage,
  selectPageExecutionHostKey
} from '../client-pages/browser-host-client-page-placement'

export class BrowserHostLeaseRegistry {
  readonly authorityRuntimeId: string
  readonly authorityEpoch: string
  private readonly generations = new BrowserHostGenerationCounter()
  private readonly leasesByClientId = new Map<string, BrowserHostLeaseState>()
  private readonly tunnels = new BrowserHostTunnelRegistry()
  private readonly pageGrants = new Map<string, BrowserClientPageExecutionHostGrant>()
  private readonly pagePlacements: BrowserHostPagePlacementRegistry
  private readonly controllers: ReturnType<typeof createBrowserHostLeaseControllers>

  constructor(private readonly options: BrowserHostLeaseRegistryOptions) {
    this.authorityRuntimeId = options.authorityRuntimeId
    this.authorityEpoch = options.authorityEpoch ?? randomUUID()
    this.pagePlacements = new BrowserHostPagePlacementRegistry({
      authorityRuntimeId: this.authorityRuntimeId,
      authorityEpoch: this.authorityEpoch
    })
    this.controllers = createBrowserHostLeaseControllers(
      this,
      this.pagePlacements,
      this.pageGrants,
      {
        leases: this.leasesByClientId,
        tunnels: this.tunnels,
        reconnectGraceMs: options.reconnectGraceMs,
        initializationChanged: options.onClientPageInitializationChanged,
        fence: (state, reason) => this.fenceLease(state, reason),
        fenceReconciliation: (state) => this.fenceReconciliation(state)
      }
    )
  }

  attach(
    input: BrowserHostLeaseAttachInput,
    onReconciled: () => void = () => {}
  ): BrowserHostLeaseHandle {
    return attachBrowserHostLease(input, {
      authorityRuntimeId: this.authorityRuntimeId,
      authorityEpoch: this.authorityEpoch,
      leasesByClientId: this.leasesByClientId,
      reconnects: this.controllers.reconnects,
      generations: this.generations,
      observeInventory: this.controllers.observeInventory(onReconciled),
      fenceLease: (state) => this.fenceLease(state, 'replaced')
    })
  }

  sealClientPageInitializations(
    identity: BrowserHostLeaseIdentity & { connectionId?: string },
    blocked: boolean
  ): void {
    this.controllers.sealInitializations(identity, blocked)
  }

  select(browserHostClientId?: string, capabilities: readonly string[] = []): BrowserHostLease {
    return selectActiveBrowserHostLease(this.leasesByClientId, browserHostClientId, capabilities)
  }

  requireLease(identity: BrowserHostLeaseIdentity): BrowserHostLease {
    return this.requireLeaseState(identity).lease
  }

  requireClientPageConnection(input: BrowserClientPageConnectionInput) {
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

  createClientPage(options: BrowserHostClientPageCreateOptions) {
    return createBrowserHostClientPage(options, {
      selectLease: (clientId, capabilities) => this.select(clientId, capabilities),
      requireLeaseState: (lease) => this.requireLeaseState(lease),
      pagePlacements: this.pagePlacements,
      executionHostGrants: this.pageGrants,
      initializations: this.controllers.initializations
    })
  }

  admitClientPageInitialization(
    identity: BrowserHostLeaseIdentity,
    input: BrowserHostPageInitializationInput
  ) {
    return this.controllers.initializations.admit(this.requireLeaseState(identity), input)
  }

  get clientPageInitializations() {
    return this.controllers.initializations
  }

  claimLegacyClientPageRecovery(
    identity: BrowserHostLeaseIdentity,
    input: BrowserHostLegacyPageRecoveryInput
  ) {
    const state = this.requireLeaseState(identity)
    return this.controllers.initializations.claimLegacyRecovery(state, input)
  }

  cancelClientPageInitialization(
    browserPageId: string,
    expected: RuntimeBrowserClientPlacement
  ): boolean {
    return this.controllers.initializations.cancel(browserPageId, expected)
  }

  switchClientPageProfile(
    authority: BrowserClientPageAuthority,
    profile: Parameters<typeof switchBrowserHostClientProfile>[1],
    onLateCommit?: (placement: RuntimeBrowserClientPlacement) => void
  ) {
    return switchBrowserHostClientProfile(authority, profile, {
      onLateCommit,
      registry: this,
      state: (clientId) => this.requireLeaseState(this.select(clientId, [])),
      placements: this.pagePlacements,
      grants: this.pageGrants,
      onCommitted: this.options.onClientPageReleased
    })
  }

  requireClientPage(authority: BrowserClientPageAuthority): RuntimeBrowserClientPlacement {
    return requireLiveBrowserClientPage(this.pagePlacements, this.leasesByClientId, authority)
  }

  adoptClientPages(
    identity: BrowserHostLeaseIdentity,
    intents: readonly BrowserHostRuntimePageIntent[],
    options: BrowserHostClientPageAdoptionOptions = {}
  ): Promise<readonly string[]> {
    return adoptBrowserHostClientPages(intents, options, {
      state: this.requireLeaseState(identity),
      reconciliations: this.controllers.reconciliations,
      placements: this.pagePlacements,
      executionHostGrants: this.pageGrants
    })
  }

  retireUnpublishedClientPage(
    identity: BrowserHostLeaseIdentity,
    input: BrowserHostPageInitializationInput
  ): void {
    this.controllers.initializations.retireUnpublished(this.requireLeaseState(identity), input)
  }

  attachCommandDelivery(
    identity: BrowserHostLeaseIdentity,
    delivery: (event: BrowserClientHostCommandEvent) => void
  ): () => void {
    const state = this.requireLeaseState(identity)
    const release = attachBrowserHostClientCommandDelivery(state, delivery)
    this.controllers.initializations.resume(state)
    return release
  }

  issueClientPageCommand(
    authority: BrowserClientPageAuthority,
    command: BrowserClientHostCommandEvent['command']
  ): ReturnType<typeof issueBrowserHostClientPageCommand> {
    this.requireClientPage(authority)
    return issueBrowserHostClientPageCommand(authority, command, this.leasesByClientId)
  }

  settleClientPageCommand(
    identity: BrowserHostCommandResultIdentity,
    params: BrowserHostCommandResultParams
  ): boolean {
    return settleBrowserHostClientPageCommand(
      this.requireLeaseState(identity),
      identity,
      params,
      (authority) => this.requireClientPage(authority)
    )
  }

  getPlacement(browserPageId: string): RuntimeBrowserPlacement | undefined {
    return this.pagePlacements.getPlacement(browserPageId)
  }

  getClientPageExecutionHostKey(id: string): string | undefined {
    return selectPageExecutionHostKey(id, this.pageGrants, this.pagePlacements)
  }

  beginPageRetirement(browserPageId: string, expected: RuntimeBrowserPlacement) {
    return this.pagePlacements.beginPageRetirement(browserPageId, expected)
  }

  cancelPageRetirement(retirement: BrowserPageRetirement): boolean {
    return this.pagePlacements.cancelPageRetirement(retirement)
  }

  completePageRetirement(retirement: BrowserPageRetirement): boolean {
    return completeBrowserHostPageRetirement(retirement, {
      pagePlacements: this.pagePlacements,
      leasesByClientId: this.leasesByClientId,
      executionHostGrants: this.pageGrants,
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
      retireInitializations: (fenced) => this.controllers.initializations.retireAuthority(fenced),
      clearReconnect: (fenced) => this.controllers.reconnects.clear(fenced),
      fenceReconciliation: (state) => this.fenceReconciliation(state),
      fenceRoute: (route, routeReason) => this.tunnels.fence(route, routeReason),
      releaseFencedPage: (retirement) => this.releaseFencedClientPage(retirement)
    })
  }

  private fenceReconciliation(state: BrowserHostLeaseState): void {
    this.controllers.initializations.fence(state)
    this.controllers.reconciliations.fence(state)
  }

  private releaseFencedClientPage(retirement: BrowserPageRetirement): void {
    if (this.completePageRetirement(retirement) && retirement.placement.kind === 'client') {
      this.options.onClientPageFenced?.(retirement.browserPageId, retirement.placement)
    }
  }
}

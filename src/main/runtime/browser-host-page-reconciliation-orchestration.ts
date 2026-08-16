import type { BrowserClientHostedPageInventory } from '../../shared/browser-client-host-protocol'
import type { BrowserHostLeaseState } from './browser-host-lease-records'
import type {
  BrowserHostPagePlacementRegistry,
  RuntimeBrowserPlacement
} from './browser-host-page-placement'
import { BrowserHostPageReconciliationActions } from './browser-host-page-reconciliation-actions'
import {
  executeBrowserHostPageReconciliation,
  type BrowserHostPageReconciliationResult
} from './browser-host-page-reconciliation-executor'
import {
  planBrowserHostPageReconciliation,
  type BrowserHostRuntimePageIntent
} from './browser-host-page-reconciliation-plan'

export type BrowserHostPageReconciliationOptions = {
  maxConcurrency?: number
  actionTimeoutMs?: number
  signal?: AbortSignal
}

export class BrowserHostPageReconciliationOrchestrator {
  private readonly attempts = new Map<symbol, BrowserHostPageReconciliationActions>()
  private readonly consumedInventories = new WeakSet<object>()

  constructor(
    private readonly authority: { authorityRuntimeId: string; authorityEpoch: string },
    private readonly placements: BrowserHostPagePlacementRegistry
  ) {}

  async reconcile(
    state: BrowserHostLeaseState,
    intents: readonly BrowserHostRuntimePageIntent[],
    options: BrowserHostPageReconciliationOptions = {}
  ): Promise<BrowserHostPageReconciliationResult> {
    const inventory = this.requireInventory(state)
    if (this.attempts.has(state.token)) {
      throw new Error('browser_host_page_reconciliation_pending')
    }
    if (this.consumedInventories.has(inventory)) {
      throw new Error('browser_host_page_reconciliation_inventory_consumed')
    }
    const plan = planBrowserHostPageReconciliation(intents, inventory, {
      inventoryPairedDeviceId: state.lease.pairedDeviceId
    })
    this.assertPlanAuthority(state, plan)
    const attempt = new BrowserHostPageReconciliationActions(state, this.placements, plan)
    const removeAbort = forwardAbort(options.signal, attempt.controller)
    this.consumedInventories.add(inventory)
    this.attempts.set(state.token, attempt)
    try {
      return await executeBrowserHostPageReconciliation(plan, attempt.handlers, {
        ...options,
        signal: attempt.controller.signal
      })
    } finally {
      removeAbort()
      attempt.cancelReservations()
      this.attempts.delete(state.token)
    }
  }

  fence(state: BrowserHostLeaseState): void {
    this.attempts
      .get(state.token)
      ?.controller.abort(new Error('browser_host_page_reconciliation_lease_fenced'))
  }

  observeInventory(state: BrowserHostLeaseState): void {
    const inventory = state.lease.pageInventory
    if (inventory && state.commandLedger?.hasOutstandingReconciliation()) {
      this.consumedInventories.add(inventory)
    }
  }

  private requireInventory(
    state: BrowserHostLeaseState
  ): readonly BrowserClientHostedPageInventory[] {
    if (
      state.lease.pageReconciliationProtocolVersion !== 1 ||
      state.lease.pageCommandProtocolVersion !== 1 ||
      state.lease.pageInventoryProtocolVersion !== 1 ||
      !state.commandLedger ||
      !state.lease.pageInventory
    ) {
      throw new Error('browser_host_reconciliation_protocol_required')
    }
    return state.lease.pageInventory
  }

  private assertPlanAuthority(
    state: BrowserHostLeaseState,
    plan: ReturnType<typeof planBrowserHostPageReconciliation>
  ): void {
    const intents = [
      ...plan.retain.map(({ intent }) => intent),
      ...plan.reclaim.map(({ intent }) => intent),
      ...plan.restore,
      ...plan.closeThenRestore.map(({ intent }) => intent)
    ]
    for (const intent of intents) {
      if (
        intent.authorityRuntimeId !== this.authority.authorityRuntimeId ||
        intent.authorityEpoch !== this.authority.authorityEpoch ||
        intent.browserHostClientId !== state.lease.browserHostClientId ||
        intent.browserHostGeneration !== state.lease.browserHostGeneration
      ) {
        throw new Error('browser_host_page_reconciliation_authority_stale')
      }
      state.executionHostGrants.require(intent.executionHostKey)
    }
    for (const { intent } of plan.retain) {
      this.placements.requireClientPage(intent)
    }
    for (const { intent } of [...plan.reclaim, ...plan.closeThenRestore]) {
      this.assertReplaceablePlacement(intent.browserPageId, plan)
    }
    for (const intent of plan.restore) {
      if (this.placements.getPlacement(intent.browserPageId)) {
        throw new Error('browser_page_replacement_requires_retirement')
      }
    }
    for (const page of plan.close) {
      const placement = this.placements.getPlacement(page.browserPageId)
      if (placement && !this.placementMatchesPage(placement, page)) {
        throw new Error('browser_page_replacement_requires_retirement')
      }
    }
  }

  private assertReplaceablePlacement(
    browserPageId: string,
    plan: ReturnType<typeof planBrowserHostPageReconciliation>
  ): void {
    const placement = this.placements.getPlacement(browserPageId)
    if (!placement) {
      return
    }
    const closePair = plan.closeThenRestore.find(
      ({ intent }) => intent.browserPageId === browserPageId
    )
    if (!closePair || !this.placementMatchesPage(placement, closePair.page)) {
      throw new Error('browser_page_replacement_requires_retirement')
    }
  }

  private placementMatchesPage(
    placement: RuntimeBrowserPlacement,
    page: BrowserClientHostedPageInventory
  ): boolean {
    return (
      placement.kind === 'client' &&
      page.authorityRuntimeId === this.authority.authorityRuntimeId &&
      page.authorityEpoch === this.authority.authorityEpoch &&
      placement.browserHostClientId === page.browserHostClientId &&
      placement.browserHostGeneration === page.browserHostGeneration &&
      placement.pageHostGeneration === page.pageHostGeneration
    )
  }
}

function forwardAbort(signal: AbortSignal | undefined, controller: AbortController): () => void {
  if (!signal) {
    return () => {}
  }
  const abort = (): void => controller.abort(signal.reason)
  if (signal.aborted) {
    abort()
    return () => {}
  }
  signal.addEventListener('abort', abort, { once: true })
  return () => signal.removeEventListener('abort', abort)
}

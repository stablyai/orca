import type {
  BrowserClientHostedPageInventory,
  BrowserClientHostCommandEvent,
  BrowserClientHostCommandResult
} from '../../shared/browser-client-host-protocol'
import { assertBrowserHostPageCommandAdmission } from './browser-host-page-command-admission'
import type { BrowserHostLeaseState } from './browser-host-lease-records'
import type {
  BrowserClientPagePlacementReservation,
  BrowserHostPagePlacementRegistry,
  RuntimeBrowserPlacement
} from './browser-host-page-placement'
import type { BrowserHostPageReconciliationActions as ActionHandlers } from './browser-host-page-reconciliation-executor'
import type {
  BrowserHostPageReconciliationPlan,
  BrowserHostRuntimePageIntent
} from './browser-host-page-reconciliation-plan'

export class BrowserHostPageReconciliationActions {
  readonly controller = new AbortController()
  readonly handlers: ActionHandlers
  private readonly reservations = new Map<string, BrowserClientPagePlacementReservation>()
  private readonly closePlacements = new Map<string, RuntimeBrowserPlacement | undefined>()

  constructor(
    private readonly state: BrowserHostLeaseState,
    private readonly placements: BrowserHostPagePlacementRegistry,
    private readonly plan: BrowserHostPageReconciliationPlan
  ) {
    for (const page of [
      ...this.plan.close,
      ...this.plan.closeThenRestore.map(({ page }) => page)
    ]) {
      this.closePlacements.set(page.browserPageId, this.placements.getPlacement(page.browserPageId))
    }
    this.reserveTargetPlacements()
    this.handlers = {
      reclaimPage: (pair, signal) => this.reclaimPage(pair, signal),
      closePage: (page, signal) => this.closePage(page, signal),
      restorePage: (intent, signal) => this.restorePage(intent, signal)
    }
  }

  cancelReservations(): void {
    for (const reservation of this.reservations.values()) {
      this.placements.cancelClientPageReservation(reservation)
    }
  }

  private reserveTargetPlacements(): void {
    const targets = [
      ...this.plan.reclaim.map(({ intent }) => intent),
      ...this.plan.restore,
      ...this.plan.closeThenRestore.map(({ intent }) => intent)
    ].toSorted((left, right) => left.pageHostGeneration - right.pageHostGeneration)
    try {
      for (const intent of targets) {
        const reservation = this.placements.reserveClientPage(
          intent.browserPageId,
          {
            browserHostClientId: this.state.lease.browserHostClientId,
            browserHostGeneration: this.state.lease.browserHostGeneration
          },
          intent.pageHostGeneration
        )
        this.reservations.set(intent.browserPageId, reservation)
      }
    } catch (error) {
      this.cancelReservations()
      throw error
    }
  }

  private async reclaimPage(
    pair: BrowserHostPageReconciliationPlan['reclaim'][number],
    signal: AbortSignal
  ): Promise<void> {
    await this.issueCommand(
      pair.intent.browserPageId,
      pair.intent.pageHostGeneration,
      {
        type: 'reclaimPage',
        previousAuthority: pageAuthority(pair.page),
        browserProfileId: pair.intent.browserProfileId,
        executionHostKey: pair.intent.executionHostKey,
        ...(pair.intent.workspaceId ? { workspaceId: pair.intent.workspaceId } : {})
      },
      signal
    )
    this.commitReservation(pair.intent.browserPageId)
  }

  private async closePage(
    page: BrowserClientHostedPageInventory,
    signal: AbortSignal
  ): Promise<void> {
    await this.issueCommand(
      page.browserPageId,
      page.pageHostGeneration,
      { type: 'closePage', targetAuthority: pageAuthority(page) },
      signal
    )
    const placement = this.closePlacements.get(page.browserPageId)
    if (!placement) {
      return
    }
    if (this.placements.getPlacement(page.browserPageId) !== placement) {
      throw new Error('browser_page_placement_stale')
    }
    const retirement = this.placements.beginPageRetirement(page.browserPageId, placement)
    this.placements.completePageRetirement(retirement)
  }

  private async restorePage(
    intent: BrowserHostRuntimePageIntent,
    signal: AbortSignal
  ): Promise<void> {
    const url = this.plan.closeThenRestore.find(
      (pair) => pair.intent.browserPageId === intent.browserPageId
    )?.page.currentUrl
    await this.issueCommand(
      intent.browserPageId,
      intent.pageHostGeneration,
      {
        type: 'restorePage',
        browserProfileId: intent.browserProfileId,
        executionHostKey: intent.executionHostKey,
        ...(url ? { url } : {}),
        ...(intent.workspaceId ? { workspaceId: intent.workspaceId } : {})
      },
      signal
    )
    this.commitReservation(intent.browserPageId)
  }

  private async issueCommand(
    browserPageId: string,
    pageHostGeneration: number,
    command: BrowserClientHostCommandEvent['command'],
    signal: AbortSignal
  ): Promise<void> {
    assertNotAborted(signal)
    assertBrowserHostPageCommandAdmission(this.state.lease, command, (executionHostKey) =>
      this.state.executionHostGrants.require(executionHostKey)
    )
    const ledger = this.state.commandLedger
    if (!ledger) {
      throw new Error('browser_host_command_protocol_required')
    }
    const issued = ledger.issue({
      browserPageId,
      pageHostGeneration,
      command,
      resultAdmission: 'reconciliation'
    })
    const result = await waitForCommandResult(issued.result, signal)
    if (result.status === 'failed') {
      throw new Error(result.errorCode)
    }
    assertNotAborted(signal)
  }

  private commitReservation(browserPageId: string): void {
    const reservation = this.reservations.get(browserPageId)
    if (!reservation) {
      throw new Error('browser_page_reconciliation_reservation_required')
    }
    this.placements.commitClientPageReservation(reservation)
    this.reservations.delete(browserPageId)
  }
}

function pageAuthority(page: BrowserClientHostedPageInventory) {
  return {
    authorityRuntimeId: page.authorityRuntimeId,
    authorityEpoch: page.authorityEpoch,
    browserHostClientId: page.browserHostClientId,
    browserHostGeneration: page.browserHostGeneration,
    pageHostGeneration: page.pageHostGeneration
  }
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new Error('browser_host_page_reconciliation_aborted', { cause: signal.reason })
  }
}

async function waitForCommandResult(
  result: Promise<BrowserClientHostCommandResult>,
  signal: AbortSignal
): Promise<BrowserClientHostCommandResult> {
  let removeAbort = (): void => {}
  const aborted = new Promise<never>((_resolve, reject) => {
    const abort = (): void =>
      reject(new Error('browser_host_page_reconciliation_aborted', { cause: signal.reason }))
    if (signal.aborted) {
      abort()
      return
    }
    signal.addEventListener('abort', abort, { once: true })
    removeAbort = () => signal.removeEventListener('abort', abort)
  })
  try {
    return await Promise.race([result, aborted])
  } finally {
    removeAbort()
  }
}

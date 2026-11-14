import type { BrowserHostLeaseState } from '../leases/browser-host-lease-records'
import type { RuntimeBrowserClientPlacement } from '../../../../shared/runtime-browser-placement'

export function closeUncommittedClientPage(
  state: BrowserHostLeaseState,
  browserPageId: string,
  placement: RuntimeBrowserClientPlacement
): void {
  const ledger = state.commandLedger
  if (!ledger) {
    return
  }
  try {
    const close = ledger.issue({
      browserPageId,
      pageHostGeneration: placement.pageHostGeneration,
      command: {
        type: 'closePage',
        targetAuthority: {
          authorityRuntimeId: state.lease.authorityRuntimeId,
          authorityEpoch: state.lease.authorityEpoch,
          browserHostClientId: placement.browserHostClientId,
          browserHostGeneration: placement.browserHostGeneration,
          pageHostGeneration: placement.pageHostGeneration
        }
      },
      resultAdmission: 'reserved-page'
    })
    void close.result.then(
      () => retireUncommittedClientPage(ledger, browserPageId, placement.pageHostGeneration),
      () => retireUncommittedClientPage(ledger, browserPageId, placement.pageHostGeneration)
    )
  } catch {
    retireUncommittedClientPage(ledger, browserPageId, placement.pageHostGeneration)
  }
}

export function retireUncommittedClientPage(
  ledger: NonNullable<BrowserHostLeaseState['commandLedger']>,
  browserPageId: string,
  pageHostGeneration: number
): void {
  try {
    ledger.retirePage(browserPageId, pageHostGeneration)
  } catch {
    // Best-effort close converges through authenticated inventory reconciliation.
  }
}

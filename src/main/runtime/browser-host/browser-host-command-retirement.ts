import type { BrowserHostLeaseState } from './browser-host-lease-records'
import type { BrowserPageRetirement } from './browser-host-page-placement'

export function retireClientPageCommandLedger(
  leasesByClientId: ReadonlyMap<string, BrowserHostLeaseState>,
  retirement: BrowserPageRetirement
): void {
  if (retirement.placement.kind !== 'client') {
    return
  }
  const state = leasesByClientId.get(retirement.placement.browserHostClientId)
  if (state?.lease.browserHostGeneration !== retirement.placement.browserHostGeneration) {
    return
  }
  state.commandLedger?.retirePage(retirement.browserPageId, retirement.placement.pageHostGeneration)
}

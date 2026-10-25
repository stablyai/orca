import { retireClientPageCommandLedger } from './browser-host-command-retirement'
import type { BrowserClientPageExecutionHostGrant } from './browser-host-client-page-creation'
import type { BrowserHostLeaseState } from './browser-host-lease-records'
import type {
  BrowserHostPagePlacementRegistry,
  BrowserPageRetirement
} from './browser-host-page-placement'

export function completeBrowserHostPageRetirement(
  retirement: BrowserPageRetirement,
  dependencies: {
    pagePlacements: BrowserHostPagePlacementRegistry
    leasesByClientId: Map<string, BrowserHostLeaseState>
    executionHostGrants: Map<string, BrowserClientPageExecutionHostGrant>
    onClientPageReleased?: (browserPageId: string) => void
  }
): boolean {
  const completed = dependencies.pagePlacements.completePageRetirement(retirement, () =>
    retireClientPageCommandLedger(dependencies.leasesByClientId, retirement)
  )
  if (completed) {
    const grant = dependencies.executionHostGrants.get(retirement.browserPageId)
    if (grant?.placement === retirement.placement) {
      dependencies.executionHostGrants.delete(retirement.browserPageId)
      grant.release()
    }
    if (retirement.placement.kind === 'client') {
      dependencies.onClientPageReleased?.(retirement.browserPageId)
    }
  }
  return completed
}

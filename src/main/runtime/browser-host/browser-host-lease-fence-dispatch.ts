import type { BrowserHostFenceReason } from './browser-host-lease-fence'
import { fenceBrowserHostLease } from './browser-host-lease-fencing'
import type { BrowserHostLeaseState, BrowserHostRouteState } from './browser-host-lease-records'
import type {
  BrowserHostPagePlacementRegistry,
  BrowserPageRetirement
} from './browser-host-page-placement'

type BrowserHostLeaseFenceDependencies = {
  leasesByClientId: Map<string, BrowserHostLeaseState>
  pagePlacements: Pick<BrowserHostPagePlacementRegistry, 'fenceClientHostPlacements'>
  clearReconnect(state: BrowserHostLeaseState): void
  fenceReconciliation(state: BrowserHostLeaseState): void
  fenceRoute(route: BrowserHostRouteState, reason: BrowserHostFenceReason): void
  releaseFencedPage(retirement: BrowserPageRetirement): void
}

export function dispatchBrowserHostLeaseFence(
  state: BrowserHostLeaseState,
  reason: BrowserHostFenceReason,
  dependencies: BrowserHostLeaseFenceDependencies
): void {
  dependencies.clearReconnect(state)
  if (dependencies.leasesByClientId.get(state.lease.browserHostClientId)?.token !== state.token) {
    return
  }
  dependencies.fenceReconciliation(state)
  const fencedPages = dependencies.pagePlacements.fenceClientHostPlacements({
    browserHostClientId: state.lease.browserHostClientId,
    browserHostGeneration: state.lease.browserHostGeneration
  })
  fenceBrowserHostLease(state, reason, dependencies.leasesByClientId, (route, routeReason) =>
    dependencies.fenceRoute(route, routeReason)
  )
  // Fenced clients cannot finish retirement; release placement/capacity here to avoid stranding it.
  // Keep the runtime page record for same-identity recovery (retainRuntimeBrowserClientPageRecord).
  for (const retirement of fencedPages) {
    try {
      dependencies.releaseFencedPage(retirement)
    } catch (error) {
      // Continue releasing the fenced lease even if one page fails.
      console.warn('[browser-host-lease] fenced page release failed:', {
        browserPageId: retirement.browserPageId,
        error
      })
    }
  }
}

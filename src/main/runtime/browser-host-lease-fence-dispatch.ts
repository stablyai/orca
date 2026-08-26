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

/** Retires one lease: its reconnect timer, reconciliation, pages, routes, and per-page state. */
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
  // Why: a fenced page never completes retirement through the client, so complete it here or the
  // placement and its capacity stay stranded for the runtime's life. The runtime page record is
  // deliberately kept — retention is what lets a returning host of the same identity recover the
  // tab — see retainRuntimeBrowserClientPageRecord for what that costs.
  for (const retirement of fencedPages) {
    try {
      dependencies.releaseFencedPage(retirement)
    } catch (error) {
      // One page's release must not abandon the rest of a lease already past the point of return.
      console.warn('[browser-host-lease] fenced page release failed:', {
        browserPageId: retirement.browserPageId,
        error
      })
    }
  }
}

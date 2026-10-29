import type { BrowserHostLeaseState, BrowserHostRouteState } from './browser-host-lease-records'
import type { BrowserHostFenceReason } from './browser-host-lease-fence'

export function fenceBrowserHostLease(
  state: BrowserHostLeaseState,
  reason: BrowserHostFenceReason,
  leasesByClientId: Map<string, BrowserHostLeaseState>,
  fenceRoute: (route: BrowserHostRouteState, reason: BrowserHostFenceReason) => void
): void {
  if (leasesByClientId.get(state.lease.browserHostClientId)?.token !== state.token) {
    return
  }
  leasesByClientId.delete(state.lease.browserHostClientId)
  for (const route of state.routes) {
    fenceRoute(route, reason === 'replaced' ? 'lease_replaced' : 'lease_released')
  }
  state.executionHostGrants.clear()
  state.commandLedger?.close()
  state.fence.resolve(reason)
}

export function fenceBrowserHostRoute(
  state: BrowserHostRouteState,
  reason: BrowserHostFenceReason,
  routesByKey: Map<string, BrowserHostRouteState>
): void {
  state.releaseGrantLink?.()
  state.releaseGrantLink = undefined
  state.lease.routes.delete(state)
  if (routesByKey.get(state.key)?.token === state.token) {
    routesByKey.delete(state.key)
  }
  state.fence.resolve(reason)
}

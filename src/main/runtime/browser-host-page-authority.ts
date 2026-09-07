import type { BrowserHostLeaseState } from './browser-host-lease-records'
import type {
  BrowserClientPageAuthority,
  BrowserHostPagePlacementRegistry
} from './browser-host-page-placement'
import type { RuntimeBrowserClientPlacement } from '../../shared/runtime-browser-placement'

export function requireLiveBrowserClientPage(
  placements: BrowserHostPagePlacementRegistry,
  leasesByClientId: Map<string, BrowserHostLeaseState>,
  authority: BrowserClientPageAuthority
): RuntimeBrowserClientPlacement {
  const placement = placements.requireClientPage(authority)
  const lease = leasesByClientId.get(authority.browserHostClientId)
  if (!lease) {
    throw new Error('browser_host_lease_required')
  }
  if (lease.lease.browserHostGeneration !== authority.browserHostGeneration) {
    throw new Error('browser_host_lease_stale')
  }
  if (lease.status !== 'active') {
    throw new Error('browser_host_lease_reconnecting')
  }
  return placement
}

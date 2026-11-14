import type { BrowserClientPageExecutionHostGrant } from './browser-host-client-page-creation'
import type { BrowserHostLease } from '../leases/browser-host-lease-records'
import type { BrowserHostPagePlacementRegistry } from '../reconciliation/browser-host-page-placement'
import type { RuntimeBrowserPlacement } from '../../../../shared/runtime-browser-placement'
import { BROWSER_HOST_WEBVIEW_CAPABILITY } from '../leases/browser-host-capability-selection'

export function placeBrowserHostClientPage(options: {
  browserPageId: string
  browserHostClientId?: string
  requiredCapabilities: readonly string[]
  pagePlacements: BrowserHostPagePlacementRegistry
  selectLease(
    browserHostClientId: string | undefined,
    capabilities: readonly string[]
  ): BrowserHostLease
}): RuntimeBrowserPlacement {
  options.pagePlacements.assertPlacementAdmission(options.browserPageId)
  const lease = options.selectLease(options.browserHostClientId, [
    BROWSER_HOST_WEBVIEW_CAPABILITY,
    ...options.requiredCapabilities
  ])
  return options.pagePlacements.placeClientPage(options.browserPageId, {
    browserHostClientId: lease.browserHostClientId,
    browserHostGeneration: lease.browserHostGeneration
  })
}

export function selectPageExecutionHostKey(
  id: string,
  grants: Map<string, BrowserClientPageExecutionHostGrant>,
  placements: BrowserHostPagePlacementRegistry
): string | undefined {
  const grant = grants.get(id)
  return grant && placements.getPlacement(id) === grant.placement
    ? grant.executionHostKey
    : undefined
}

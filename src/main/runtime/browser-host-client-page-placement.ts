import type { BrowserHostLease } from './browser-host-lease-records'
import type { BrowserHostPagePlacementRegistry } from './browser-host-page-placement'
import type { RuntimeBrowserPlacement } from '../../shared/runtime-browser-placement'
import { BROWSER_HOST_WEBVIEW_CAPABILITY } from './browser-host-capability-selection'

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

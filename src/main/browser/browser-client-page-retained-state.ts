import type { BrowserClientHostedPageInventory } from '../../shared/browser-client-host-protocol'
import type {
  BrowserClientPageNetworkRoute,
  BrowserClientPageRenderer
} from './browser-client-page-cleanup'
import type {
  BrowserRouteGuestLifecycleClaim,
  BrowserRoutePageGuestIdentity
} from './browser-route-page-authority'
import type { BrowserRouteSessionHandle } from './browser-route-session-state'
import type { BrowserRouteWebContentsRegistry } from './browser-route-webcontents-registry'

export type BrowserClientPageLifecycleRegistry = Pick<
  BrowserRouteWebContentsRegistry,
  | 'claimGuestLifecycle'
  | 'registerGuest'
  | 'grantNavigation'
  | 'revokeNavigation'
  | 'navigateGuest'
  | 'beginGuestRetirement'
> &
  Partial<Pick<BrowserRouteWebContentsRegistry, 'rekeyGuestLifecycle' | 'watchPageAvailability'>> &
  Partial<Pick<BrowserRouteWebContentsRegistry, 'grantReconciledNavigation'>>

export type BrowserClientRetainedPage = {
  generation: number
  inventory: BrowserClientHostedPageInventory
  registration: BrowserRoutePageGuestIdentity
  lifecycleClaim: BrowserRouteGuestLifecycleClaim
  renderer: BrowserClientPageRenderer
  route: BrowserClientPageNetworkRoute
  routeSession: BrowserRouteSessionHandle
  retiring: Promise<void> | null
  reconciling: boolean
  releaseAvailabilityWatch?: () => void
}

/** The live page a guest WebContents belongs to; retiring/reconciling pages are not addressable. */
export function findBrowserClientPageByWebContentsId(
  pages: Iterable<BrowserClientRetainedPage>,
  webContentsId: number
): BrowserClientRetainedPage | undefined {
  for (const page of pages) {
    if (page.registration.webContentsId === webContentsId && !page.retiring && !page.reconciling) {
      return page
    }
  }
  return undefined
}

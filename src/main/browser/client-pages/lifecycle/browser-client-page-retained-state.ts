import type {
  BrowserClientHostedPageInventory,
  BrowserClientHostCommandEvent
} from '../../../../shared/browser/client-hosting/browser-client-host-protocol'
import type { BrowserClientPageNetworkRoute } from '../../network/client-routes/browser-client-page-network-route'
import type { BrowserClientPageRenderer } from '../renderer/browser-client-page-renderer-contract'
import type {
  BrowserRouteGuestLifecycleClaim,
  BrowserRoutePageGuestIdentity
} from '../../routing/guest-authority/browser-route-page-authority'
import type { BrowserRouteSessionHandle } from '../../routing/sessions/browser-route-session-state'
import type { BrowserRouteWebContentsRegistry } from '../../routing/guest-authority/browser-route-webcontents-registry'

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
  Partial<Pick<BrowserRouteWebContentsRegistry, 'grantReconciledNavigation' | 'initializeGuest'>>

export type BrowserClientRetainedPage = {
  generation: number
  inventory: BrowserClientHostedPageInventory
  /** The createPage that made this guest, without its initial URL; Memory Saver remakes it. */
  createEvent: BrowserClientHostCommandEvent
  registration: BrowserRoutePageGuestIdentity
  lifecycleClaim: BrowserRouteGuestLifecycleClaim
  renderer: BrowserClientPageRenderer
  route: BrowserClientPageNetworkRoute
  routeSession: BrowserRouteSessionHandle
  cleanup?: (() => Promise<void>) & { nativeNetworkRetired?(): boolean }
  retiring: Promise<void> | null
  reconciling: boolean
  releaseAvailabilityWatch?: () => void
}

/** The jar a hosted page reads: its own profile on its own network host. */
export type BrowserClientPageCookieJar = { partition: string; browserProfileId: string }

/** Null while the page retires or reconciles, when its jar may be about to change. */
export function retainedBrowserClientPageCookieJar(
  page: BrowserClientRetainedPage | undefined
): BrowserClientPageCookieJar | null {
  if (!page || page.retiring || page.reconciling) {
    return null
  }
  return {
    partition: page.registration.partition,
    browserProfileId: page.inventory.browserProfileId
  }
}

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

export function forgetBrowserClientRetainedPage(
  pages: Map<string, BrowserClientRetainedPage>,
  browserPageId: string,
  page: BrowserClientRetainedPage
): void {
  if (pages.get(browserPageId) === page) {
    pages.delete(browserPageId)
  }
}

export async function retireBrowserClientRetainedPage(
  pages: Map<string, BrowserClientRetainedPage>,
  browserPageId: string,
  pageHostGeneration: number,
  cleanupPage: (page: BrowserClientRetainedPage) => Promise<void>
): Promise<boolean> {
  const page = pages.get(browserPageId)
  if (!page || page.generation !== pageHostGeneration) {
    return false
  }
  page.retiring = cleanupPage(page)
  try {
    await page.retiring
  } catch (error) {
    page.inventory = Object.freeze({ ...page.inventory, state: 'outcomeUnknown' })
    throw error
  }
  forgetBrowserClientRetainedPage(pages, browserPageId, page)
  return true
}

import type { BrowserRoutePageGuestIdentity } from './browser-route-page-authority'
import type { BrowserClientRetainedPage } from './browser-client-page-retained-state'

export function markBrowserClientPageUnavailable(
  pages: ReadonlyMap<string, BrowserClientRetainedPage>,
  registration: BrowserRoutePageGuestIdentity,
  onUnavailable: (browserPageId: string, pageHostGeneration: number) => void
): boolean {
  const page = pages.get(registration.browserPageId)
  if (
    !page ||
    page.retiring ||
    page.reconciling ||
    page.inventory.state !== 'active' ||
    page.generation !== registration.pageHostGeneration ||
    page.registration.webContentsId !== registration.webContentsId ||
    page.registration.rendererWebContentsId !== registration.rendererWebContentsId
  ) {
    return false
  }
  page.inventory = Object.freeze({ ...page.inventory, state: 'outcomeUnknown' })
  onUnavailable(registration.browserPageId, page.generation)
  return true
}

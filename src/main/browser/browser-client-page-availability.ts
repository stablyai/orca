import type { BrowserClientPageCommandExecutorDependencies } from './browser-client-page-command-executor-dependencies'
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

export function publishBrowserClientRetainedPage(
  dependencies: BrowserClientPageCommandExecutorDependencies,
  pages: Map<string, BrowserClientRetainedPage>,
  page: BrowserClientRetainedPage
): void {
  const previous = pages.get(page.inventory.browserPageId)
  previous?.releaseAvailabilityWatch?.()
  if (previous) {
    previous.releaseAvailabilityWatch = undefined
  }
  page.releaseAvailabilityWatch = dependencies.routeWebContents.watchPageAvailability?.(
    page.inventory.browserPageId,
    (registration) =>
      markBrowserClientPageUnavailable(pages, registration, (browserPageId, generation) =>
        dependencies.onPageUnavailable?.(browserPageId, generation)
      )
  )
  pages.set(page.inventory.browserPageId, page)
}

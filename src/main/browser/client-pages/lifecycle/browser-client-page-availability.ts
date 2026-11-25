import type { BrowserClientPageCommandExecutorDependencies } from '../execution/browser-client-page-command-executor-dependencies'
import type { BrowserRoutePageGuestIdentity } from '../../routing/guest-authority/browser-route-page-authority'
import type { BrowserClientRetainedPage } from './browser-client-page-retained-state'

export function markBrowserClientPageUnavailable(
  pages: ReadonlyMap<string, BrowserClientRetainedPage>,
  registration: BrowserRoutePageGuestIdentity,
  onUnavailable: (browserPageId: string, pageHostGeneration: number) => void
): boolean {
  const page = pages.get(registration.browserPageId)
  if (
    !matchesBrowserClientRetainedPage(pages, page, registration) ||
    page.retiring ||
    page.reconciling ||
    page.inventory.state !== 'active'
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
  page: BrowserClientRetainedPage,
  onInitializationUnavailable?: () => void
): void {
  const previous = pages.get(page.inventory.browserPageId)
  previous?.releaseAvailabilityWatch?.()
  if (previous) {
    previous.releaseAvailabilityWatch = undefined
  }
  page.releaseAvailabilityWatch = dependencies.routeWebContents.watchPageAvailability?.(
    page.inventory.browserPageId,
    (registration) => {
      if (!matchesBrowserClientRetainedPage(pages, page, registration)) {
        return false
      }
      if (page.inventory.state === 'outcomeUnknown') {
        onInitializationUnavailable?.()
      }
      return markBrowserClientPageUnavailable(pages, registration, (browserPageId, generation) =>
        dependencies.onPageUnavailable?.(browserPageId, generation)
      )
    }
  )
  pages.set(page.inventory.browserPageId, page)
}

function matchesBrowserClientRetainedPage(
  pages: ReadonlyMap<string, BrowserClientRetainedPage>,
  page: BrowserClientRetainedPage | undefined,
  registration: BrowserRoutePageGuestIdentity
): page is BrowserClientRetainedPage {
  return Boolean(
    page &&
    pages.get(registration.browserPageId) === page &&
    page.registration.partition === registration.partition &&
    page.registration.browserPageId === registration.browserPageId &&
    page.generation === registration.pageHostGeneration &&
    page.registration.pageHostGeneration === registration.pageHostGeneration &&
    page.registration.rendererWebContentsId === registration.rendererWebContentsId &&
    page.registration.webContentsId === registration.webContentsId
  )
}

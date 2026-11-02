import type { BrowserRouteGuestLifecycleClaim } from './browser-route-page-authority'
import { BrowserClientPageCommandError } from './browser-client-page-command-failure'

type BrowserClientPageNavigationClaim = { lifecycleClaim: BrowserRouteGuestLifecycleClaim }

export class BrowserClientPageNavigationFence {
  private fenced = false

  get isFenced(): boolean {
    return this.fenced
  }

  assertAvailable(closed: boolean): void {
    if (closed || this.fenced) {
      throw new BrowserClientPageCommandError('browser_client_page_executor_closed')
    }
  }

  fence(
    pages: Iterable<BrowserClientPageNavigationClaim>,
    revoke: (claim: BrowserRouteGuestLifecycleClaim) => void
  ): void {
    if (this.fenced) {
      return
    }
    this.fenced = true
    this.revoke(pages, revoke)
  }

  revoke(
    pages: Iterable<BrowserClientPageNavigationClaim>,
    revoke: (claim: BrowserRouteGuestLifecycleClaim) => void
  ): void {
    const failures: unknown[] = []
    for (const page of pages) {
      try {
        revoke(page.lifecycleClaim)
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Browser client page navigation fencing failed')
    }
  }

  fenceBeforeCleanup(
    pages: Iterable<BrowserClientPageNavigationClaim>,
    revoke: (claim: BrowserRouteGuestLifecycleClaim) => void,
    cleanup: () => Promise<void>
  ): Promise<void> {
    let fencingFailed = false
    let fencingError: unknown
    try {
      this.fence(pages, revoke)
    } catch (error) {
      fencingFailed = true
      fencingError = error
    }
    const cleanupPromise = cleanup()
    if (!fencingFailed) {
      return cleanupPromise
    }
    return cleanupPromise.then(
      () => {
        throw fencingError
      },
      (cleanupError) => {
        throw new AggregateError(
          [fencingError, cleanupError],
          'Browser client page fencing and cleanup failed'
        )
      }
    )
  }
}

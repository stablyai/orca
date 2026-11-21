import { holdBrowserSessionRequestGate } from '../../../sessions/requests/browser-session-request-gate'
import { observeBrowserGuestRequests } from '../../../sessions/requests/browser-session-web-request-observer'
import type { createFormPostNavigationTracker } from './browser-guest-form-post-navigation'

/**
 * The real request method of each main-frame navigation when a session listens, else the form
 * report's. A navigation expected to POST keeps the session listening until a hop proves GET,
 * it commits, or it ends; an unseen method stays protected.
 */
export function watchBrowserGuestNavigationMethods(
  guest: Electron.WebContents,
  formPost: ReturnType<typeof createFormPostNavigationTracker>
): { started: (url: string) => void; committed: () => boolean; dispose: () => void } {
  let pendingMethod: string | null = null
  let release: (() => void) | null = null
  const stopWatching = (): void => {
    release?.()
    release = null
  }
  const stopRequests = observeBrowserGuestRequests(guest.id, (session, event, details) => {
    if (
      event === 'onBeforeRequest' &&
      details.resourceType === 'mainFrame' &&
      session === guest.session
    ) {
      pendingMethod = details.method
      // A redirect can't turn a GET back into a POST.
      if (details.method === 'GET') {
        stopWatching()
      }
    }
  })
  // An error ends the navigation without a commit; a 204 or a download aborts silently and is
  // released when loading stops.
  const failed = (
    _event: Electron.Event,
    _code: number,
    _description: string,
    _url: string,
    isMainFrame: boolean
  ): void => {
    if (isMainFrame) {
      stopWatching()
    }
  }
  guest.on('did-fail-load', failed)
  guest.on('did-stop-loading', stopWatching)
  return {
    started: (url) => {
      pendingMethod = null
      stopWatching()
      if (formPost.started(url)) {
        release = holdBrowserSessionRequestGate(guest.session)
      }
    },
    committed: () => {
      stopWatching()
      return formPost.committed(guest.getURL(), pendingMethod)
    },
    dispose: () => {
      stopRequests()
      stopWatching()
      guest.off('did-fail-load', failed)
      guest.off('did-stop-loading', stopWatching)
    }
  }
}

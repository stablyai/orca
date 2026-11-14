import type { EventEmitter } from 'node:events'
import type { BrowserRouteGuestLifecycleClaim } from './browser-route-page-authority'
import type { BrowserRouteGuestState } from './browser-route-webcontents-state'
import type { WebContents } from 'electron'
import { normalizeBrowserNavigationUrl } from '../../../../shared/browser-url'

/** The controlled bootstrap document has finished and stopped before this owner starts. */
export function initializeBrowserRouteGuest(
  guest: Pick<WebContents, 'loadURL' | 'stop'> & Pick<EventEmitter, 'on' | 'removeListener'>,
  rawUrl: string,
  signal: AbortSignal,
  isCurrent: () => boolean
): Promise<string> {
  const url = normalizeBrowserNavigationUrl(rawUrl)
  if (!url || url.startsWith('file:') || signal.aborted || !isCurrent()) {
    return Promise.reject(new Error('browser_client_page_initialization_stale'))
  }
  return new Promise((resolve, reject) => {
    let settled = false
    const remove = (): void => {
      guest.removeListener('did-navigate', committed)
      guest.removeListener('did-navigate-in-page', inPage)
      guest.removeListener('did-fail-provisional-load', failedDocument)
      guest.removeListener('destroyed', lost)
      guest.removeListener('render-process-gone', lost)
      signal.removeEventListener('abort', abort)
    }
    const finish = (destination?: string): void => {
      if (settled) {
        return
      }
      settled = true
      remove()
      const normalized =
        destination === undefined ? null : normalizeBrowserNavigationUrl(destination)
      if (normalized && !normalized.startsWith('file:') && !signal.aborted && isCurrent()) {
        resolve(normalized)
      } else {
        reject(new Error('browser_client_page_initialization_failed'))
      }
    }
    const committed = (_event: Electron.Event, destination: string): void => finish(destination)
    const inPage = (_event: Electron.Event, destination: string, mainFrame: boolean): void => {
      if (mainFrame) {
        finish(destination)
      }
    }
    const failedDocument = (
      _event: Electron.Event,
      code: number,
      _description: string,
      destination: string,
      mainFrame: boolean
    ): void => {
      // Electron emits this only for committed error documents; did-fail-load also covers noncommits.
      if (mainFrame && code !== -3) {
        finish(destination)
      }
    }
    const lost = (): void => finish()
    const abort = (): void => {
      const owned = isCurrent()
      finish()
      if (owned) {
        try {
          guest.stop()
        } catch {
          /* Native teardown may already have started. */
        }
      }
    }
    guest.on('did-navigate', committed)
    guest.on('did-navigate-in-page', inPage)
    guest.on('did-fail-provisional-load', failedDocument)
    guest.on('destroyed', lost)
    guest.on('render-process-gone', lost)
    signal.addEventListener('abort', abort, { once: true })
    try {
      void guest.loadURL(url).then(
        () => {
          if (!settled) {
            finish()
          }
        },
        () => {
          if (!settled) {
            finish()
          }
        }
      )
    } catch {
      finish()
    }
  })
}

export function initializeClaimedBrowserRouteGuest(
  claim: BrowserRouteGuestLifecycleClaim,
  url: string,
  signal: AbortSignal,
  guests: Map<number, BrowserRouteGuestState>,
  hasAuthority: (state: BrowserRouteGuestState) => boolean
): Promise<string> {
  const state = guests.get(claim.registration.webContentsId)
  const isCurrent = (): boolean =>
    Boolean(
      state &&
      guests.get(claim.registration.webContentsId) === state &&
      state.guestAuthority === claim.guestAuthority &&
      state.navigationGranted &&
      hasAuthority(state)
    )
  if (!state || !isCurrent()) {
    return Promise.reject(new Error('browser_client_page_initialization_stale'))
  }
  return initializeBrowserRouteGuest(state.guest, url, signal, isCurrent)
}

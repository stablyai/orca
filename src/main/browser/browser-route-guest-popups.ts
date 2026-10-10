import type { Session, WebContents } from 'electron'
import { normalizeBrowserNavigationUrl } from '../../shared/browser-url'
import { ORCA_BROWSER_BLANK_URL } from '../../shared/constants'
import { enforceBrowserRouteWebRtcPolicy } from './browser-route-webrtc-policy'
import {
  trackBrowserRouteGuestPopupGesture,
  type BrowserRouteGuestPopupGesture
} from './browser-route-guest-popup-gesture'
import {
  registerBrowserRouteGuestPopup,
  releaseBrowserRouteGuestPopup
} from './browser-route-guest-popup-ownership'
import {
  ROUTE_POPUP_WINDOW_OPTIONS,
  type BrowserRouteGuestPopupWindow
} from './browser-route-guest-popup-window-options'
import { openPopupWithOriginBar, type PopupChildWindowOptions } from './popup-origin-bar-window'

/** Bounded so a page holding a real gesture stream cannot paper the desktop in windows. */
export const MAX_BROWSER_ROUTE_GUEST_POPUPS = 4

export type BrowserRouteGuestPopupDependencies = {
  getPartitionForSession: (session: Session) => string | null
  /** Route guests replace the manager's popup handler, so a denial is otherwise entirely silent. */
  reportBlockedPopup?: (input: { openerWebContentsId: number; url: string }) => void
  /** Seam for tests; production always opens the shared origin-bar window. */
  openPopupWindow?: (
    options: PopupChildWindowOptions,
    targetUrl: string,
    prepareContent: (contents: WebContents) => boolean
  ) => BrowserRouteGuestPopupWindow
}

export type BrowserRouteGuestPopupController = {
  windowOpenHandler: (details?: { url?: string }) => Electron.WindowOpenHandlerResponse
  /** Fence: opener closed, retired, suspended, or its lease/authority is gone. */
  closeAll: () => void
  dispose: () => void
}

export function createBrowserRouteGuestPopupController(input: {
  opener: WebContents
  partition: string
  isNavigationAllowed: (url: string) => boolean
  dependencies: BrowserRouteGuestPopupDependencies
}): BrowserRouteGuestPopupController {
  const openPopupWindow = input.dependencies.openPopupWindow ?? openPopupWithOriginBar
  const popups = new Set<BrowserRouteGuestPopupWindow>()
  const gestures = new Set<BrowserRouteGuestPopupGesture>()
  const popupWebContentsIds = new Set<number>()
  const openerGesture = trackBrowserRouteGuestPopupGesture(input.opener)
  gestures.add(openerGesture)
  // Why only dispose latches: fencing must be reversible, because a reconnected page regains
  // navigation authority and its OAuth popups have to work again. `isNavigationAllowed` is what
  // holds new popups shut while the page is fenced.
  let disposed = false

  const onPopupNavigate = (event: Electron.Event, url: string): void => {
    if (disposed || !input.isNavigationAllowed(url)) {
      event.preventDefault()
    }
  }

  const preparePopupContents = (contents: WebContents): boolean => {
    let contentsPartition: string | null = null
    let popupWebContentsId = 0
    try {
      contentsPartition = input.dependencies.getPartitionForSession(contents.session)
      popupWebContentsId = contents.id
    } catch {
      contentsPartition = null
    }
    if (disposed || contentsPartition !== input.partition) {
      return false
    }
    // Fail closed exactly like guest admission: no WebRTC policy, no content — otherwise the STUN
    // UDP leak the route guests already close reopens through popups.
    if (!enforceBrowserRouteWebRtcPolicy(contents, () => {})) {
      return false
    }
    const gesture = trackBrowserRouteGuestPopupGesture(contents)
    gestures.add(gesture)
    try {
      // Descendants inherit the same envelope; nothing about being a popup relaxes it.
      contents.setWindowOpenHandler(buildWindowOpenHandler(gesture))
      contents.on('will-navigate', onPopupNavigate)
      contents.on('will-redirect', onPopupNavigate)
      // Ownership before first load: a download can start on the popup's very first navigation, and
      // an unowned route popup fails closed instead of routing to the opener's remote workspace.
      // Descendants register against the root opener, so a chain never needs walking.
      registerPopupOwnership(popupWebContentsId)
      contents.once('destroyed', () => {
        releasePopupOwnership(popupWebContentsId)
        gestures.delete(gesture)
        gesture.dispose()
      })
    } catch {
      releasePopupOwnership(popupWebContentsId)
      gestures.delete(gesture)
      gesture.dispose()
      return false
    }
    return true
  }

  const registerPopupOwnership = (popupWebContentsId: number): void => {
    let openerWebContentsId = 0
    try {
      openerWebContentsId = input.opener.id
    } catch {
      return
    }
    popupWebContentsIds.add(popupWebContentsId)
    registerBrowserRouteGuestPopup({ popupWebContentsId, openerWebContentsId })
  }

  const reportBlockedPopup = (rawUrl: unknown): void => {
    try {
      input.dependencies.reportBlockedPopup?.({
        openerWebContentsId: input.opener.id,
        url: typeof rawUrl === 'string' ? rawUrl : ''
      })
    } catch {
      // A missing notice must never turn a denial into an exception the page can observe.
    }
  }

  const releasePopupOwnership = (popupWebContentsId: number): void => {
    popupWebContentsIds.delete(popupWebContentsId)
    releaseBrowserRouteGuestPopup(popupWebContentsId)
  }

  const openPopup = (options: PopupChildWindowOptions, targetUrl: string): WebContents => {
    const popup = openPopupWindow(options, targetUrl, preparePopupContents)
    popups.add(popup)
    popup.onClosed(() => popups.delete(popup))
    if (disposed) {
      popup.close()
    }
    return popup.contentWebContents
  }

  function buildWindowOpenHandler(
    gesture: BrowserRouteGuestPopupGesture
  ): (details?: { url?: string }) => Electron.WindowOpenHandlerResponse {
    return (details) => {
      const normalized = normalizeRoutePopupUrl(details?.url)
      if (
        disposed ||
        !normalized ||
        popups.size >= MAX_BROWSER_ROUTE_GUEST_POPUPS ||
        !input.isNavigationAllowed(normalized) ||
        !gesture.consume()
      ) {
        // Not when disposed: the opener is gone, so there is no pane left to tell.
        if (!disposed) {
          reportBlockedPopup(details?.url)
        }
        return { action: 'deny' }
      }
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          ...ROUTE_POPUP_WINDOW_OPTIONS,
          webPreferences: {
            ...ROUTE_POPUP_WINDOW_OPTIONS.webPreferences,
            // Why: the opener's cookie jar AND its fixed SOCKS proxy — egress stays remote even
            // for contents Chromium creates without an opener relationship.
            partition: input.partition
          }
        },
        createWindow: (options: PopupChildWindowOptions) => openPopup(options, normalized)
      }
    }
  }

  // Set iteration tolerates the re-entrant delete that close() triggers through onClosed.
  const closeAll = (): void => {
    for (const popup of popups) {
      popups.delete(popup)
      try {
        popup.close()
      } catch {}
    }
  }

  return {
    windowOpenHandler: buildWindowOpenHandler(openerGesture),
    closeAll,
    dispose: () => {
      disposed = true
      closeAll()
      // The opener is gone, so its popups own nothing: drop ownership now rather than waiting for
      // each popup's `destroyed`, which would leave a window for a download to route to a dead page.
      for (const popupWebContentsId of popupWebContentsIds) {
        releasePopupOwnership(popupWebContentsId)
      }
      for (const gesture of gestures) {
        gestures.delete(gesture)
        gesture.dispose()
      }
    }
  }
}

// A blank popup carries no destination the origin bar can verify and no OAuth flow to complete.
function normalizeRoutePopupUrl(rawUrl: unknown): string | null {
  if (typeof rawUrl !== 'string') {
    return null
  }
  let normalized: string | null = null
  try {
    normalized = normalizeBrowserNavigationUrl(rawUrl)
  } catch {
    return null
  }
  return !normalized || normalized === ORCA_BROWSER_BLANK_URL ? null : normalized
}

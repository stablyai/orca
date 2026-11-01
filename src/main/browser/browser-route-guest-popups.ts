import type { Session, WebContents } from 'electron'
import { ORCA_BROWSER_BLANK_URL } from '../../shared/constants'
import { isBlankBrowserPopupUrl, normalizeBrowserPopupUrl } from './browser-popup-new-tab-intent'
import { enforceBrowserRouteWebRtcPolicy } from './browser-route-webrtc-policy'
import {
  trackBrowserGuestInputGesture,
  type BrowserGuestInputGesture
} from './browser-guest-input-gesture'
import {
  registerBrowserRouteGuestPopup,
  releaseBrowserRouteGuestPopup
} from './browser-route-guest-popup-ownership'
import {
  ROUTE_POPUP_WINDOW_OPTIONS,
  type BrowserRouteGuestPopupWindow
} from './browser-route-guest-popup-window-options'
import { openPopupWithOriginBar, type PopupChildWindowOptions } from './popup-origin-bar-window'
import { allowNativeBrowserPopup, isNativeBrowserPopupRequest } from './browser-popup-native-window'
import { allowPageUnload } from './browser-guest-unload-policy'

export const MAX_BROWSER_ROUTE_GUEST_POPUPS = 4

export type BrowserRouteGuestPopupDependencies = {
  getPartitionForSession: (session: Session) => string | null
  /** Route guests replace the manager's popup handler, so a denial is otherwise entirely silent. */
  reportBlockedPopup?: (input: { openerWebContentsId: number; url: string }) => void
  openPopupWindow?: (
    options: PopupChildWindowOptions,
    targetUrl: string,
    prepareContent: (contents: WebContents) => boolean
  ) => BrowserRouteGuestPopupWindow
}

export type BrowserRouteGuestPopupController = {
  windowOpenHandler: (details?: PopupRequest) => Electron.WindowOpenHandlerResponse
  closeAll: () => void
  dispose: () => void
}

type PopupRequest = {
  url?: string
  referrer?: Electron.Referrer
  postBody?: Electron.PostBody | null
  disposition?: string
  features?: string
  frameName?: string
}

export function createBrowserRouteGuestPopupController(input: {
  opener: WebContents
  partition: string
  /** Blank popup documents still require live route authority. */
  isNavigationAllowed: (url: string) => boolean
  dependencies: BrowserRouteGuestPopupDependencies
}): BrowserRouteGuestPopupController {
  const openPopupWindow = input.dependencies.openPopupWindow ?? openPopupWithOriginBar
  const popups = new Set<BrowserRouteGuestPopupWindow>()
  const gestures = new Set<BrowserGuestInputGesture>()
  const popupWebContentsIds = new Set<number>()
  const openerGesture = trackBrowserGuestInputGesture(input.opener)
  gestures.add(openerGesture)
  // Only disposal is permanent; navigation authority may return after reconnect.
  let disposed = false

  const navigationAllowed = (url: string): boolean =>
    input.isNavigationAllowed(isBlankBrowserPopupUrl(url) ? ORCA_BROWSER_BLANK_URL : url)

  const onPopupNavigate = (event: Electron.Event, url: string): void => {
    if (disposed || !normalizeBrowserPopupUrl(url) || !navigationAllowed(url)) {
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
    if (
      disposed ||
      contentsPartition !== input.partition ||
      !navigationAllowed(ORCA_BROWSER_BLANK_URL)
    ) {
      return false
    }
    // Reject popups without the route WebRTC policy to prevent direct STUN/UDP egress.
    if (!enforceBrowserRouteWebRtcPolicy(contents, () => {})) {
      return false
    }
    const gesture = trackBrowserGuestInputGesture(contents)
    gestures.add(gesture)
    try {
      contents.setWindowOpenHandler(buildWindowOpenHandler(contents, gesture))
      contents.on('will-navigate', onPopupNavigate)
      contents.on('will-redirect', onPopupNavigate)
      // Popups skip attachGuestPolicies, so install its unload rule here.
      contents.on('will-prevent-unload', allowPageUnload)
      // Register before first navigation so downloads can resolve the root page.
      registerPopupOwnership(popupWebContentsId)
      if (disposed || !navigationAllowed(ORCA_BROWSER_BLANK_URL)) {
        releasePopupOwnership(popupWebContentsId)
        gestures.delete(gesture)
        gesture.dispose()
        return false
      }
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
      // Notification failure must not expose an exception to the page.
    }
  }

  const releasePopupOwnership = (popupWebContentsId: number): void => {
    popupWebContentsIds.delete(popupWebContentsId)
    releaseBrowserRouteGuestPopup(popupWebContentsId)
  }

  const openPopup = (options: PopupChildWindowOptions, targetUrl: string): WebContents => {
    if (!options.webContents && !options.nativeWindow && !options.loadInitialUrl) {
      reportBlockedPopup(targetUrl)
    }
    const popup = openPopupWindow(options, targetUrl, preparePopupContents)
    popups.add(popup)
    popup.onClosed(() => popups.delete(popup))
    if (disposed) {
      popup.close()
    }
    return popup.contentWebContents
  }

  function buildWindowOpenHandler(
    source: WebContents,
    gesture: BrowserGuestInputGesture
  ): (details?: PopupRequest) => Electron.WindowOpenHandlerResponse {
    return (details) => {
      const clicked = gesture.consume()
      const normalized = normalizeBrowserPopupUrl(details?.url)
      if (
        disposed ||
        !normalized ||
        popups.size >= MAX_BROWSER_ROUTE_GUEST_POPUPS ||
        !navigationAllowed(normalized) ||
        !clicked
      ) {
        if (!disposed) {
          reportBlockedPopup(details?.url)
        }
        return { action: 'deny' }
      }
      const options = {
        ...ROUTE_POPUP_WINDOW_OPTIONS,
        webPreferences: {
          ...ROUTE_POPUP_WINDOW_OPTIONS.webPreferences,
          // Inherit the opener's cookies and SOCKS route even without a Chromium opener relationship.
          partition: input.partition
        }
      }
      if (isNativeBrowserPopupRequest(details ?? {})) {
        return allowNativeBrowserPopup({
          // Electron reports a script-opened child to the contents whose handler answered.
          opener: source,
          options,
          background: details?.disposition === 'background-tab',
          canPresent: () => !disposed && navigationAllowed(ORCA_BROWSER_BLANK_URL),
          onCreated: (nativeOptions) => openPopup(nativeOptions, details?.url ?? normalized)
        })
      }
      return {
        action: 'allow',
        overrideBrowserWindowOptions: options,
        createWindow: (options: PopupChildWindowOptions) =>
          openPopup(
            {
              ...options,
              // Reopening a POST by URL would discard its body.
              loadInitialUrl:
                !options.webContents && !details?.postBody && !isBlankBrowserPopupUrl(normalized)
            },
            details?.url ?? normalized
          )
      }
    }
  }

  const closeAll = (): void => {
    for (const popup of popups) {
      popups.delete(popup)
      try {
        popup.close()
      } catch {}
    }
  }

  return {
    windowOpenHandler: buildWindowOpenHandler(input.opener, openerGesture),
    closeAll,
    dispose: () => {
      disposed = true
      closeAll()
      // Release ownership before asynchronous destruction so downloads cannot target a retired page.
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

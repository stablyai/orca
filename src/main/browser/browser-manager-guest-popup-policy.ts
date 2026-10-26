import { shell } from 'electron'
import { normalizeExternalBrowserUrl, redactKagiSessionToken } from '../../shared/browser-url'
import { trackBrowserGuestInputGesture } from './browser-guest-input-gesture'
import {
  isNewBrowserTabPopupIntent,
  isBrowserTabPopupRequest,
  normalizeBrowserPopupUrl
} from './browser-popup-new-tab-intent'
import { SAFE_POPUP_WINDOW_OPTIONS, safeOrigin } from './browser-manager-types'
import { openPopupWithOriginBar, type PopupChildWindowOptions } from './popup-origin-bar-window'
import { BrowserManagerNavigation } from './browser-manager-navigation'
import {
  allowNativeBrowserPopup,
  discardBrowserPopupContents,
  isNativeBrowserPopupRequest
} from './browser-popup-native-window'
import { isBrowserRouteGuestPopup } from './browser-route-guest-popup-ownership'
import { requestBrowserExternalAppLaunch } from './browser-external-app-launch'

export abstract class BrowserManagerGuestPopupPolicy extends BrowserManagerNavigation {
  protected installGuestPopupPolicy(guest: Electron.WebContents): () => void {
    const gesture = trackBrowserGuestInputGesture(guest)
    const handleDidCreateWindow = (window: Electron.BrowserWindow): void => {
      // Popups inherit ownership without replacing the primary guest registration.
      if (!isBrowserRouteGuestPopup(window.webContents.id)) {
        this.attachGuestPolicies(window.webContents, this.resolvePopupOwnerContext(guest.id))
      }
    }
    guest.on('did-create-window', handleDidCreateWindow)
    guest.setWindowOpenHandler(({ url, frameName, disposition, postBody, features, referrer }) => {
      // Spend activation even on popups so it cannot fund a later tab.
      const clicked = gesture.consume()
      const ownerContext = this.resolvePopupOwnerContext(guest.id)
      const browserTabId = ownerContext?.browserTabId ?? null
      const externalUrl = normalizeExternalBrowserUrl(url)
      // Opener-dependent requests retain a child window instead of becoming tabs.
      if (
        ownerContext &&
        externalUrl &&
        isNewBrowserTabPopupIntent({ url, frameName, disposition, postBody })
      ) {
        // Scripted opens persist as tabs, so opens without observed input consume a budget.
        if (!clicked && !this.tryConsumePageInitiatedTab(ownerContext.rootGuestWebContentsId)) {
          this.forwardOrQueuePopupEvent(guest.id, {
            origin: safeOrigin(externalUrl),
            action: 'blocked'
          })
          return { action: 'deny' }
        }
        if (
          this.openLinkInOrcaTab(
            ownerContext.browserTabId,
            externalUrl,
            disposition !== 'background-tab'
          )
        ) {
          this.forwardOrQueuePopupEvent(guest.id, {
            origin: safeOrigin(externalUrl),
            action: 'opened-in-orca'
          })
        }
        // A vanished renderer must not turn new-tab intent into a native popup.
        return { action: 'deny' }
      }

      // Native popups must not target local files.
      const canOpenAsChild = normalizeBrowserPopupUrl(url) !== null
      if (browserTabId && canOpenAsChild) {
        // A tab-shaped GET needs no OAuth child window when it has no opener.
        const tabUrl =
          externalUrl && isBrowserTabPopupRequest({ frameName, disposition, postBody })
            ? externalUrl
            : null
        const openAsTabWithoutOpener = (
          options: PopupChildWindowOptions
        ): Electron.WebContents | null =>
          tabUrl && !(options.nativeWindow?.webContents ?? options.webContents)?.opener
            ? this.openPopupAsBrowserTab(guest, tabUrl, options, {
                clicked,
                activate: disposition !== 'background-tab'
              })
            : null
        if (isNativeBrowserPopupRequest({ disposition, features, frameName })) {
          return allowNativeBrowserPopup({
            opener: guest,
            options: SAFE_POPUP_WINDOW_OPTIONS,
            background: disposition === 'background-tab',
            canPresent: () => Boolean(this.resolvePopupOwnerContext(guest.id)),
            onCreated: (options) =>
              openAsTabWithoutOpener(options) ??
              this.createPopupChildWindowWithOriginBar(guest, url, options)
          })
        }
        // Restrict page-requested chrome so native popups remain verifiable and escapable.
        return {
          action: 'allow',
          overrideBrowserWindowOptions: SAFE_POPUP_WINDOW_OPTIONS,
          // Host child windows with an origin bar so users can verify the destination.
          createWindow: (options: PopupChildWindowOptions) =>
            openAsTabWithoutOpener(options) ??
            this.createPopupChildWindowWithOriginBar(guest, url, {
              ...options,
              // Bind link-created contents to the opener's session.
              webPreferences: { ...options.webPreferences, session: guest.session }
            })
        }
      } else if (externalUrl && !postBody) {
        // Redact the Kagi bearer token before opening the OS browser.
        void shell.openExternal(redactKagiSessionToken(externalUrl))
        this.forwardOrQueuePopupEvent(guest.id, {
          origin: safeOrigin(externalUrl),
          action: 'opened-external'
        })
      } else if (!this.requestExternalAppLaunch(guest, url, () => referrer.url || null)) {
        // Report only the origin: popup URLs can contain one-time tokens.
        this.forwardOrQueuePopupEvent(guest.id, {
          origin: safeOrigin(url),
          action: 'blocked'
        })
      }
      return { action: 'deny' }
    })

    return () => {
      gesture.dispose()
      try {
        guest.off('did-create-window', handleDidCreateWindow)
      } catch {
        // guest may already be destroyed
      }
    }
  }

  requestExternalAppLaunch(
    guest: Electron.WebContents,
    rawUrl: string | undefined,
    requestingUrl: () => string | null
  ): boolean {
    // Credit the requesting frame, not the trusted top-level site.
    return requestBrowserExternalAppLaunch({
      requester: guest,
      target: this.resolvePagePromptTarget(guest),
      rawUrl,
      requestingUrl
    })
  }

  /** The tab loads the URL; discard the provisional popup before its first request. */
  private openPopupAsBrowserTab(
    opener: Electron.WebContents,
    url: string,
    options: PopupChildWindowOptions,
    tab: { clicked: boolean; activate: boolean }
  ): Electron.WebContents {
    const owner = this.resolvePopupOwnerContext(opener.id)
    const opened =
      owner !== null &&
      (tab.clicked || this.tryConsumePageInitiatedTab(owner.rootGuestWebContentsId)) &&
      this.openLinkInOrcaTab(owner.browserTabId, url, tab.activate)
    this.forwardOrQueuePopupEvent(opener.id, {
      origin: safeOrigin(url),
      action: opened ? 'opened-in-orca' : 'blocked'
    })
    if (options.webContents && !options.nativeWindow) {
      // Discard directly to avoid flashing a window that would immediately close.
      discardBrowserPopupContents(options.webContents)
      return options.webContents
    }
    return openPopupWithOriginBar(options, url, () => false).contentWebContents
  }
}

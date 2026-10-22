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
    // Why: a fresh input marks a click, which bypasses the page-initiated tab budget.
    const gesture = trackBrowserGuestInputGesture(guest)
    const handleDidCreateWindow = (window: Electron.BrowserWindow): void => {
      // Why: popup descendants inherit the opener's owner context but must not replace its primary registration.
      if (!isBrowserRouteGuestPopup(window.webContents.id)) {
        this.attachGuestPolicies(window.webContents, this.resolvePopupOwnerContext(guest.id))
      }
    }
    guest.on('did-create-window', handleDidCreateWindow)
    guest.setWindowOpenHandler(({ url, frameName, disposition, postBody, features, referrer }) => {
      // Why: as in Chrome, every open spends the click, so a popup's click cannot fund a later tab.
      const clicked = gesture.consume()
      const ownerContext = this.resolvePopupOwnerContext(guest.id)
      const browserTabId = ownerContext?.browserTabId ?? null
      const externalUrl = normalizeExternalBrowserUrl(url)
      // Why: one rule for every link and window.open; opener-dependent shapes are excluded by
      // isNewBrowserTabPopupIntent and still get a real child window below.
      if (
        ownerContext &&
        externalUrl &&
        isNewBrowserTabPopupIntent({ url, frameName, disposition, postBody })
      ) {
        // Why: one activation lets a page loop window.open, and each routed tab persists into
        // workspace session state, so only opens beyond the observed clicks draw on the budget.
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
        // Why: a recognized new-tab intent must never fall through to a native popup if its renderer vanished mid-open.
        return { action: 'deny' }
      }

      // Why: file URLs are fine for in-pane previews, but must not spawn native child windows targeting local paths.
      const canOpenAsChild = normalizeBrowserPopupUrl(url) !== null
      if (browserTabId && canOpenAsChild) {
        // Why: the OAuth rule keeps a tab-shaped GET out of tabs only to save its opener. A plain link
        // has none and a Cmd/Ctrl+Shift-click hands over no page at all, so both are ordinary tabs.
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
        // Why: OAuth may request size/position, but content must not create deceptive or inescapable native chrome.
        return {
          action: 'allow',
          overrideBrowserWindowOptions: SAFE_POPUP_WINDOW_OPTIONS,
          // Why: default child windows lack an address bar; host in an Orca origin-bar window so the destination is verifiable.
          createWindow: (options: PopupChildWindowOptions) =>
            openAsTabWithoutOpener(options) ??
            this.createPopupChildWindowWithOriginBar(guest, url, {
              ...options,
              // Link-created contents have no inherited session until we bind the opener's jar.
              webPreferences: { ...options.webPreferences, session: guest.session }
            })
        }
      } else if (externalUrl && !postBody) {
        // Why: Kagi target=_blank popup URLs still contain the bearer token; redact before handing to the OS browser.
        void shell.openExternal(redactKagiSessionToken(externalUrl))
        this.forwardOrQueuePopupEvent(guest.id, {
          origin: safeOrigin(externalUrl),
          action: 'opened-external'
        })
      } else if (!this.requestExternalAppLaunch(guest, url, () => referrer.url || null)) {
        // Why: popup URLs can carry auth redirects/one-time tokens; surface only sanitized origin metadata.
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

  /** Every route from a page into another app ends here, so they all share one prompt. */
  requestExternalAppLaunch(
    guest: Electron.WebContents,
    rawUrl: string | undefined,
    requestingUrl: () => string | null
  ): boolean {
    // Why: the top page's URL would credit an embedded frame's request to the site the user trusts.
    return requestBrowserExternalAppLaunch({
      requester: guest,
      target: this.resolvePagePromptTarget(guest),
      rawUrl,
      requestingUrl
    })
  }

  /** The tab loads the URL itself, so Chromium's page ends before its first request. */
  private openPopupAsBrowserTab(
    opener: Electron.WebContents,
    url: string,
    options: PopupChildWindowOptions,
    tab: { clicked: boolean; activate: boolean }
  ): Electron.WebContents {
    const owner = this.resolvePopupOwnerContext(opener.id)
    // Same budget as any routed tab: opens beyond the observed clicks draw on it.
    const opened =
      owner !== null &&
      (tab.clicked || this.tryConsumePageInitiatedTab(owner.rootGuestWebContentsId)) &&
      this.openLinkInOrcaTab(owner.browserTabId, url, tab.activate)
    this.forwardOrQueuePopupEvent(opener.id, {
      origin: safeOrigin(url),
      action: opened ? 'opened-in-orca' : 'blocked'
    })
    if (options.webContents && !options.nativeWindow) {
      // Why: discarding directly avoids flashing an origin-bar window that would close at once.
      discardBrowserPopupContents(options.webContents)
      return options.webContents
    }
    return openPopupWithOriginBar(options, url, () => false).contentWebContents
  }
}

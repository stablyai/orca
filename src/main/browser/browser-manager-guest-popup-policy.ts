import { shell } from 'electron'
import { ORCA_BROWSER_BLANK_URL } from '../../shared/constants'
import {
  normalizeBrowserNavigationUrl,
  normalizeExternalBrowserUrl,
  redactKagiSessionToken
} from '../../shared/browser-url'
import { trackBrowserGuestInputGesture } from './browser-guest-input-gesture'
import { isNewBrowserTabPopupIntent } from './browser-popup-new-tab-intent'
import { SAFE_POPUP_WINDOW_OPTIONS, safeOrigin } from './browser-manager-types'
import type { PopupChildWindowOptions } from './popup-origin-bar-window'
import { BrowserManagerNavigation } from './browser-manager-navigation'

export abstract class BrowserManagerGuestPopupPolicy extends BrowserManagerNavigation {
  protected installGuestPopupPolicy(guest: Electron.WebContents): () => void {
    // Why: a fresh input marks a click, which bypasses the page-initiated tab budget.
    const gesture = trackBrowserGuestInputGesture(guest)
    const handleDidCreateWindow = (window: Electron.BrowserWindow): void => {
      // Why: popup descendants inherit the opener's owner context but must not replace its primary registration.
      this.attachGuestPolicies(window.webContents, this.resolvePopupOwnerContext(guest.id))
    }
    guest.on('did-create-window', handleDidCreateWindow)
    guest.setWindowOpenHandler(({ url, frameName, disposition }) => {
      // Why: as in Chrome, every open spends the click, so a popup's click cannot fund a later tab.
      const clicked = gesture.consume()
      const ownerContext = this.resolvePopupOwnerContext(guest.id)
      const browserTabId = ownerContext?.browserTabId ?? null
      const browserUrl = normalizeBrowserNavigationUrl(url)
      const externalUrl = normalizeExternalBrowserUrl(url)
      // Why: one rule for every link and window.open; opener-dependent shapes are excluded by
      // isNewBrowserTabPopupIntent and still get a real child window below.
      if (ownerContext && externalUrl && isNewBrowserTabPopupIntent({ frameName, disposition })) {
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
      const canOpenAsChild = Boolean(externalUrl || browserUrl === ORCA_BROWSER_BLANK_URL)
      if (browserTabId && canOpenAsChild) {
        // Why: OAuth may request size/position, but content must not create deceptive or inescapable native chrome.
        return {
          action: 'allow',
          overrideBrowserWindowOptions: SAFE_POPUP_WINDOW_OPTIONS,
          // Why: default child windows lack an address bar; host in an Orca origin-bar window so the destination is verifiable.
          createWindow: (options: PopupChildWindowOptions) =>
            this.createPopupChildWindowWithOriginBar(guest, url, options)
        }
      } else if (externalUrl) {
        // Why: Kagi target=_blank popup URLs still contain the bearer token; redact before handing to the OS browser.
        void shell.openExternal(redactKagiSessionToken(externalUrl))
        this.forwardOrQueuePopupEvent(guest.id, {
          origin: safeOrigin(externalUrl),
          action: 'opened-external'
        })
      } else {
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
}

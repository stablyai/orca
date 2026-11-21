import { shell } from 'electron'
import {
  normalizeExternalBrowserUrl,
  redactKagiSessionToken
} from '../../../../../shared/browser/navigation/browser-url'
import {
  trackBrowserGuestInputGesture,
  type ObservedBrowserGuestGesture
} from '../../input/browser-guest-input-gesture'
import {
  isNewBrowserTabPopupIntent,
  isBrowserTabPopupRequest,
  waitsForPopupOpener,
  normalizeBrowserPopupUrl,
  type NewBrowserTabPopupRequest
} from '../../popups/browser-popup-new-tab-intent'
import { SAFE_POPUP_WINDOW_OPTIONS } from '../../popups/presentation/browser-popup-window-policy'
import { safeOrigin } from '../../browser-event-origin'
import {
  discardPopupChildWindow,
  openPopupWithOriginBar,
  popupChildOpener
} from '../../popups/presentation/popup-origin-bar-window'
import type { PopupChildWindowOptions } from '../../popups/presentation/browser-popup-window-contract'
import { BrowserManagerNavigation } from '../navigation/browser-manager-navigation'
import {
  allowNativeBrowserPopup,
  isNativeBrowserPopupRequest
} from '../../popups/presentation/browser-popup-native-window'
import { watchBrowserPopupSiteFrameRemoval } from '../navigation/browser-guest-frame-user-agent-demand'
import { isBrowserRouteGuestPopup } from '../../../routing/guest-authority/browser-route-guest-popup-ownership'
import { requestBrowserExternalAppLaunch } from '../../prompts/browser-external-app-launch'

export abstract class BrowserManagerGuestPopupPolicy extends BrowserManagerNavigation {
  protected installGuestPopupPolicy(guest: Electron.WebContents): () => void {
    const gesture = trackBrowserGuestInputGesture(guest, {
      onActivatingInput: (byAgent) => {
        this.creditPageInput(guest.id)
        if (!byAgent) {
          this.releaseAgentLead(guest.id)
        }
      }
    })
    const handleDidCreateWindow = (window: Electron.BrowserWindow): void => {
      // Popups inherit ownership without replacing the primary guest registration.
      if (!isBrowserRouteGuestPopup(window.webContents.id)) {
        this.attachGuestPolicies(window.webContents, this.resolvePopupOwnerContext(guest.id))
        watchBrowserPopupSiteFrameRemoval(window.webContents)
        this.inheritAgentLead(guest.id, window.webContents.id)
      }
    }
    guest.on('did-create-window', handleDidCreateWindow)
    guest.setWindowOpenHandler(({ url, frameName, disposition, postBody, features, referrer }) => {
      // Spend activation even on popups so it cannot fund a later tab.
      const observed = gesture.consume()
      const request = { url, frameName, disposition, postBody }
      if (this.openNewTabPopup(guest, request, observed)) {
        return { action: 'deny' }
      }
      // Only the desktop user's own click may bring a popup forward; agents and late opens wait.
      const showWhenAppActive = observed?.byAgent !== false
      const browserTabId = this.resolvePopupOwnerContext(guest.id)?.browserTabId ?? null
      const externalUrl = normalizeExternalBrowserUrl(url)

      // Native popups must not target local files.
      const canOpenAsChild = normalizeBrowserPopupUrl(url) !== null
      if (browserTabId && canOpenAsChild) {
        const openAsTabWithoutOpener = (
          options: PopupChildWindowOptions
        ): Electron.WebContents | null =>
          this.openNewTabPopup(guest, request, observed, popupChildOpener(options))
            ? discardPopupChildWindow(options, url)
            : null
        if (isNativeBrowserPopupRequest({ disposition, features, frameName })) {
          return allowNativeBrowserPopup({
            opener: guest,
            options: SAFE_POPUP_WINDOW_OPTIONS,
            background: disposition === 'background-tab',
            showWhenAppActive,
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
              showWhenAppActive,
              // Bind link-created contents to the opener's session.
              webPreferences: { ...options.webPreferences, session: guest.session }
            })
        }
      } else if (externalUrl && !postBody && observed?.byAgent === false) {
        // The OS browser takes the foreground, so only the desktop user's own click opens it. Redact Kagi's bearer token first.
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

  /**
   * Answers a new-tab request as an Orca tab; false leaves opener-dependent requests to a child window.
   * Once Chromium has created the child, pass its `childOpener`: only a child without one becomes a tab.
   */
  openNewTabPopup(
    guest: Electron.WebContents,
    request: NewBrowserTabPopupRequest,
    observed: ObservedBrowserGuestGesture | null,
    childOpener?: Electron.WebFrameMain | null
  ): boolean {
    const ownerContext = this.resolvePopupOwnerContext(guest.id)
    const newTabUrl =
      normalizeExternalBrowserUrl(request.url) ??
      (isLocalFileLinkFromLocalPage(guest, request.url) ? request.url : null)
    const answersAsTab =
      childOpener === undefined
        ? isNewBrowserTabPopupIntent(request) && !waitsForPopupOpener(request, observed)
        : childOpener === null && isBrowserTabPopupRequest(request)
    if (!ownerContext || !newTabUrl || !answersAsTab) {
      return false
    }
    // Scripted opens persist as tabs, so opens without observed input consume a budget.
    if (!observed && !this.tryConsumePageInitiatedTab(ownerContext.rootGuestWebContentsId)) {
      this.forwardOrQueuePopupEvent(guest.id, { origin: safeOrigin(newTabUrl), action: 'blocked' })
      return true
    }
    // A new tab's download would miss the agent's `download` claim, so save the link here.
    if (this.isAwaitingDownloadFrom(guest.id, ownerContext.rootGuestWebContentsId)) {
      guest.downloadURL(newTabUrl)
      return true
    }
    const agentOpened = observed?.byAgent !== false && this.isAgentLeadingGuest(guest.id)
    if (
      this.openLinkInOrcaTab(
        ownerContext.browserTabId,
        newTabUrl,
        request.disposition !== 'background-tab',
        agentOpened
      )
    ) {
      this.forwardOrQueuePopupEvent(guest.id, {
        origin: safeOrigin(newTabUrl),
        action: 'opened-in-orca'
      })
    }
    // A vanished renderer must not turn new-tab intent into a native popup.
    return true
  }

  requestExternalAppLaunch(
    guest: Electron.WebContents,
    rawUrl: string | undefined,
    requestingUrl: () => string | null,
    pageInitiated?: boolean
  ): boolean {
    // Credit the requesting frame, not the trusted top-level site.
    return requestBrowserExternalAppLaunch({
      requester: guest,
      target: this.resolvePagePromptTarget(guest),
      rawUrl,
      requestingUrl,
      pageInitiated
    })
  }

  reportRouteGuestPopupBlocked(input: { openerWebContentsId: number; url: string }): void {
    this.forwardOrQueuePopupEvent(input.openerWebContentsId, {
      origin: safeOrigin(input.url),
      action: 'blocked'
    })
  }

  protected createPopupChildWindowWithOriginBar(
    openerGuest: Electron.WebContents,
    targetUrl: string,
    options: PopupChildWindowOptions
  ): Electron.WebContents {
    const popup = openPopupWithOriginBar(options, targetUrl, (contents) => {
      if (openerGuest.isDestroyed() || contents.session !== openerGuest.session) {
        return false
      }
      const owner = this.resolvePopupOwnerContext(openerGuest.id)
      if (!owner) {
        return false
      }
      this.attachGuestPolicies(contents, owner)
      watchBrowserPopupSiteFrameRemoval(contents)
      this.inheritAgentLead(openerGuest.id, contents.id)
      return true
    })
    const opened = Boolean(options.webContents || options.nativeWindow)
    this.forwardOrQueuePopupEvent(openerGuest.id, {
      origin: safeOrigin(targetUrl),
      action: opened ? 'opened-in-orca' : 'blocked'
    })
    const ownerTabId = this.resolveBrowserTabIdForGuestWebContentsId(openerGuest.id)
    if (opened && ownerTabId) {
      this.pageEvents.emit(ownerTabId, {
        kind: 'popup',
        action: 'window',
        origin: safeOrigin(targetUrl)
      })
    }
    // Close session-bearing popups with their owning guest to avoid orphan windows.
    const closePopupWithOpener = (): void => popup.close()
    openerGuest.once('destroyed', closePopupWithOpener)
    popup.onClosed(() => {
      if (!openerGuest.isDestroyed()) {
        openerGuest.off('destroyed', closePopupWithOpener)
      }
    })
    return popup.contentWebContents
  }
}

// Web pages must not reach the filesystem; only a local page may link to local files.
export function isLocalFileLinkFromLocalPage(guest: Electron.WebContents, url: string): boolean {
  return url.startsWith('file:') && guest.getURL().startsWith('file:')
}

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
import type {
  PopupOwnerContext,
  ServerPagePopupPresentation
} from '../../popups/browser-popup-ownership'
import { browserPopupPageId } from '../../popups/browser-popup-page-id'
import { watchBrowserPopupSiteFrameRemoval } from '../navigation/browser-guest-frame-user-agent-demand'
import { isBrowserRouteGuestPopup } from '../../../routing/guest-authority/browser-route-guest-popup-ownership'
import { requestBrowserExternalAppLaunch } from '../../prompts/browser-external-app-launch'
import { installBrowserJavaScriptDialogs } from '../../prompts/browser-javascript-dialogs'

export abstract class BrowserManagerGuestPopupPolicy extends BrowserManagerNavigation {
  private serverPagePopupPresenter: ((popup: ServerPagePopupPresentation) => void) | null = null

  setServerPagePopupPresenter(
    presenter: ((popup: ServerPagePopupPresentation) => void) | null
  ): void {
    this.serverPagePopupPresenter = presenter
  }

  protected installGuestPopupPolicy(guest: Electron.WebContents): () => void {
    const gesture = trackBrowserGuestInputGesture(guest, {
      isAgentCommandShownHere: (guestId) => this.isAgentCommandShownHere(guestId),
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
        this.attachPopupGuestPolicies(window.webContents, this.resolvePopupOwnerContext(guest.id))
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

      // A server page's popup reaches its viewers as a tab, never the server's own screen.
      const shownToViewers = this.isListedAsServerPage(guest.id)
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
            options: shownToViewers
              ? { ...SAFE_POPUP_WINDOW_OPTIONS, show: false }
              : SAFE_POPUP_WINDOW_OPTIONS,
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
              ...(shownToViewers ? { show: false } : {}),
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

  // A popup window's iframes run no guest preload, so removed site iframes are checked for here.
  private attachPopupGuestPolicies(
    contents: Electron.WebContents,
    owner: PopupOwnerContext | null
  ): void {
    const fresh = !this.policyAttachedGuestIds.has(contents.id)
    this.attachGuestPolicies(contents, owner)
    if (fresh) {
      watchBrowserPopupSiteFrameRemoval(contents)
      if (owner && this.isListedAsServerPage(contents.id)) {
        this.publishServerPagePopup(contents, owner)
      }
    }
  }

  /** An agent's command drives the guest's page on this desktop; a Server page is shown to its viewers instead. */
  isAgentCommandShownHere(guestWebContentsId: number): boolean {
    return (
      !this.isListedAsServerPage(guestWebContentsId) &&
      this.isAgentCommandRunning(guestWebContentsId)
    )
  }

  /** An offscreen page, or a popup one opened: viewers list both as server tabs. */
  protected isListedAsServerPage(guestWebContentsId: number): boolean {
    const rootGuestId =
      this.popupOwnerContextByGuestId.get(guestWebContentsId)?.rootGuestWebContentsId ??
      guestWebContentsId
    return this.offscreenGuestIds.has(rootGuestId)
  }

  protected notifyWorktreeBrowserGuestStateChanged(worktreeId: string): void {
    // Isolate listener exceptions from Electron event dispatch.
    try {
      this.browserGuestStateChangedListener?.(worktreeId)
    } catch (error) {
      console.error('[browser-manager] browserGuestStateChanged listener failed', error)
    }
  }

  // A server page's popup is listed as a tab; the paired client whose click opened it moves to it.
  private publishServerPagePopup(contents: Electron.WebContents, owner: PopupOwnerContext): void {
    const worktreeId = this.worktreeIdByTabId.get(owner.browserTabId)
    if (!worktreeId) {
      return
    }
    // Hidden on the server, so its viewers and agents answer its dialogs, as for the page itself.
    installBrowserJavaScriptDialogs(contents, () => null)
    // The opener may already be unregistered when its close takes the popup down.
    contents.once('destroyed', () => this.notifyWorktreeBrowserGuestStateChanged(worktreeId))
    this.notifyWorktreeBrowserGuestStateChanged(worktreeId)
    const pairedDeviceId = this.pageInputCredit.consume(owner.browserTabId)
    if (pairedDeviceId) {
      this.serverPagePopupPresenter?.({
        worktreeId,
        browserPageId: browserPopupPageId(contents.id),
        pairedDeviceId
      })
    }
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
      this.attachPopupGuestPolicies(contents, owner)
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

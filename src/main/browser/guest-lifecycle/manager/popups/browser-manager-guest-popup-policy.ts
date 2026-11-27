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
  normalizeBrowserPopupUrl,
  type NewBrowserTabPopupRequest
} from '../../popups/browser-popup-new-tab-intent'
import { safeOrigin } from '../../browser-event-origin'
import type { PopupChildWindowOptions } from '../../popups/presentation/browser-popup-window-contract'
import { BrowserManagerNavigation } from '../navigation/browser-manager-navigation'
import type {
  PopupOwnerContext,
  ServerPageLinkTabPresentation,
  ServerPagePopupClosure,
  ServerPagePopupPresentation
} from '../../popups/browser-popup-ownership'
import {
  allowManagedGuestPopupWindow,
  isLocalFileLinkFromLocalPage,
  openManagedGuestNewTabPopup,
  openManagedPopupChildWindow,
  publishBrowserPopupToViewers,
  resolvePopupViewerTarget,
  type PopupViewerTarget
} from '../../popups/browser-viewer-popup-publication'
import { watchBrowserPopupSiteFrameRemoval } from '../navigation/browser-guest-frame-user-agent-demand'
import { isBrowserRouteGuestPopup } from '../../../routing/guest-authority/browser-route-guest-popup-ownership'
import { requestBrowserExternalAppLaunch } from '../../prompts/browser-external-app-launch'

export { isLocalFileLinkFromLocalPage }

export abstract class BrowserManagerGuestPopupPolicy extends BrowserManagerNavigation {
  private serverPagePopupPresenter: ((popup: ServerPagePopupPresentation) => void) | null = null
  private serverPagePopupCloser: ((popup: ServerPagePopupClosure) => Promise<void> | void) | null =
    null
  protected serverPageLinkTabPresenter: ((link: ServerPageLinkTabPresentation) => void) | null =
    null
  private readonly pendingPopupViewerTargetByOpener = new WeakMap<
    Electron.WebContents,
    PopupViewerTarget
  >()

  setServerPagePopupPresenter(fn: typeof this.serverPagePopupPresenter): void {
    this.serverPagePopupPresenter = fn
  }

  setServerPagePopupCloser(fn: typeof this.serverPagePopupCloser): void {
    this.serverPagePopupCloser = fn
  }

  setServerPageLinkTabPresenter(fn: typeof this.serverPageLinkTabPresenter): void {
    this.serverPageLinkTabPresenter = fn
  }

  protected installGuestPopupPolicy(guest: Electron.WebContents): () => void {
    const gesture = trackBrowserGuestInputGesture(guest, {
      isAgentCommandShownHere: (guestId) => this.isAgentCommandShownHere(guestId),
      isPairedViewerCommandRunning: (guestId) => this.isPersonCommandRunning(guestId),
      onActivatingInput: (byAgent) => {
        this.creditPageInput(guest.id)
        if (!byAgent) {
          this.releaseAgentLead(guest.id)
        }
      }
    })
    const handleDidCreateWindow = (window: Electron.BrowserWindow): void => {
      // Popups inherit ownership without replacing the primary guest registration.
      const viewerTarget = this.pendingPopupViewerTargetByOpener.get(guest)
      this.pendingPopupViewerTargetByOpener.delete(guest)
      if (!isBrowserRouteGuestPopup(window.webContents.id)) {
        this.attachPopupGuestPolicies(
          window.webContents,
          this.resolvePopupOwnerContext(guest.id),
          this.pageIdForGuest(guest.id),
          viewerTarget
        )
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
      const browserTabId = this.resolvePopupOwnerContext(guest.id)?.browserTabId ?? null
      const externalUrl = normalizeExternalBrowserUrl(url)

      // Decide once per open: hidden, not offscreen (Electron never paints offscreen window.open children).
      const viewerTarget = this.resolveRoutePopupViewerTarget(guest.id, observed)
      const shownToViewers = viewerTarget.shownToViewers
      // Only the desktop user's own click may bring a popup forward; agents and late opens wait.
      const showWhenAppActive = !shownToViewers && observed?.byAgent !== false
      // Native popups must not target local files.
      const canOpenAsChild = normalizeBrowserPopupUrl(url) !== null
      if (browserTabId && canOpenAsChild) {
        this.pendingPopupViewerTargetByOpener.set(guest, viewerTarget)
        return allowManagedGuestPopupWindow({
          opener: guest,
          url,
          disposition,
          features,
          frameName,
          shownToViewers,
          showWhenAppActive,
          canPresent: () => Boolean(this.resolvePopupOwnerContext(guest.id)),
          tryOpenAsTabWithoutOpener: (childOpener) => {
            const openedAsTab = this.openNewTabPopup(guest, request, observed, childOpener)
            if (openedAsTab) {
              this.pendingPopupViewerTargetByOpener.delete(guest)
            }
            return openedAsTab
          },
          createChildWindow: (options) =>
            this.createPopupChildWindowWithOriginBar(guest, url, options, viewerTarget)
        })
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

  openNewTabPopup(
    guest: Electron.WebContents,
    request: NewBrowserTabPopupRequest,
    observed: ObservedBrowserGuestGesture | null,
    childOpener?: Electron.WebFrameMain | null
  ): boolean {
    return openManagedGuestNewTabPopup({
      guest,
      ownerContext: this.resolvePopupOwnerContext(guest.id),
      request,
      observed,
      childOpener,
      tryConsumePageInitiatedTab: (rootGuestId) => this.tryConsumePageInitiatedTab(rootGuestId),
      isAwaitingDownloadFrom: (guestId, rootGuestId) =>
        this.isAwaitingDownloadFrom(guestId, rootGuestId),
      isAgentLeadingGuest: (guestId) => this.isAgentLeadingGuest(guestId),
      openLinkInOrcaTab: (tabId, url, activate, agentOpened) =>
        this.openLinkInOrcaTab(tabId, url, activate, agentOpened),
      forwardPopupEvent: (guestId, event) => this.forwardOrQueuePopupEvent(guestId, event)
    })
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
    owner: PopupOwnerContext | null,
    immediateOpenerPageId?: string,
    viewerTarget?: PopupViewerTarget
  ): void {
    const fresh = !this.policyAttachedGuestIds.has(contents.id)
    this.attachGuestPolicies(contents, owner)
    if (!fresh) {
      return
    }
    watchBrowserPopupSiteFrameRemoval(contents)
    if (owner && viewerTarget?.shownToViewers) {
      this.publishServerPagePopup(
        contents,
        owner,
        viewerTarget.pairedDeviceId,
        immediateOpenerPageId
      )
    }
  }

  resolveRoutePopupViewerTarget(
    openerWebContentsId: number,
    observed?: ObservedBrowserGuestGesture | null
  ): PopupViewerTarget {
    return resolvePopupViewerTarget({
      isListedAsServerPage: this.isListedAsServerPage(openerWebContentsId),
      browserTabId: this.resolvePopupOwnerContext(openerWebContentsId)?.browserTabId ?? null,
      immediatePageId: this.pageIdForGuest(openerWebContentsId),
      peekCreditDeviceId: (tabId) => this.pageInputCredit.peek(tabId),
      observed
    })
  }

  publishRouteGuestPopup(
    openerGuest: Electron.WebContents,
    popupContents: Electron.WebContents,
    viewerTarget?: PopupViewerTarget
  ): void {
    const owner = this.resolvePopupOwnerContext(openerGuest.id)
    if (owner && viewerTarget?.shownToViewers) {
      this.publishServerPagePopup(
        popupContents,
        owner,
        viewerTarget.pairedDeviceId,
        this.pageIdForGuest(openerGuest.id)
      )
    }
  }

  /** An agent's command drives the guest's page on this desktop; a Server page is shown to its viewers instead. */
  isAgentCommandShownHere(guestWebContentsId: number): boolean {
    return (
      !this.isListedAsServerPage(guestWebContentsId) &&
      this.isAgentCommandRunning(guestWebContentsId)
    )
  }

  isListedAsServerPage(guestWebContentsId: number): boolean {
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

  private publishServerPagePopup(
    contents: Electron.WebContents,
    owner: PopupOwnerContext,
    pairedDeviceId: string | null,
    immediateOpenerPageId?: string
  ): void {
    this.pageInputCredit.consume(owner.browserTabId)
    publishBrowserPopupToViewers({
      contents,
      owner,
      worktreeId: this.worktreeIdByTabId.get(owner.browserTabId),
      immediateOpenerPageId,
      pairedDeviceId,
      presentPopup: this.serverPagePopupPresenter,
      closePopup: this.serverPagePopupCloser,
      notifyGuestStateChanged: (worktreeId) =>
        this.notifyWorktreeBrowserGuestStateChanged(worktreeId)
    })
  }

  protected createPopupChildWindowWithOriginBar(
    openerGuest: Electron.WebContents,
    targetUrl: string,
    options: PopupChildWindowOptions,
    viewerTarget?: PopupViewerTarget
  ): Electron.WebContents {
    return openManagedPopupChildWindow({
      openerGuest,
      targetUrl,
      options,
      prepareContent: (contents) => {
        if (openerGuest.isDestroyed() || contents.session !== openerGuest.session) {
          return false
        }
        const owner = this.resolvePopupOwnerContext(openerGuest.id)
        if (!owner) {
          return false
        }
        this.pendingPopupViewerTargetByOpener.delete(openerGuest)
        this.attachPopupGuestPolicies(
          contents,
          owner,
          this.pageIdForGuest(openerGuest.id),
          viewerTarget
        )
        this.inheritAgentLead(openerGuest.id, contents.id)
        return true
      },
      openerTabId: this.resolveBrowserTabIdForGuestWebContentsId(openerGuest.id),
      forwardPopupEvent: (guestId, event) => this.forwardOrQueuePopupEvent(guestId, event),
      emitPageEvent: (tabId, event) => this.pageEvents.emit(tabId, event)
    })
  }
}

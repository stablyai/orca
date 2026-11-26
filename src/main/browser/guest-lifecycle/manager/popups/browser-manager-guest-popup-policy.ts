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
  isPopupShownToPairedViewers,
  openManagedPopupChildWindow,
  publishBrowserPopupToViewers
} from '../../popups/browser-viewer-popup-publication'
import { watchBrowserPopupSiteFrameRemoval } from '../navigation/browser-guest-frame-user-agent-demand'
import { isBrowserRouteGuestPopup } from '../../../routing/guest-authority/browser-route-guest-popup-ownership'
import { requestBrowserExternalAppLaunch } from '../../prompts/browser-external-app-launch'

export abstract class BrowserManagerGuestPopupPolicy extends BrowserManagerNavigation {
  private serverPagePopupPresenter: ((popup: ServerPagePopupPresentation) => void) | null = null
  private serverPagePopupCloser: ((popup: ServerPagePopupClosure) => Promise<void> | void) | null =
    null
  protected serverPageLinkTabPresenter: ((link: ServerPageLinkTabPresentation) => void) | null =
    null

  setServerPagePopupPresenter(
    presenter: ((popup: ServerPagePopupPresentation) => void) | null
  ): void {
    this.serverPagePopupPresenter = presenter
  }

  setServerPagePopupCloser(
    closer: ((popup: ServerPagePopupClosure) => Promise<void> | void) | null
  ): void {
    this.serverPagePopupCloser = closer
  }

  setServerPageLinkTabPresenter(
    presenter: ((link: ServerPageLinkTabPresentation) => void) | null
  ): void {
    this.serverPageLinkTabPresenter = presenter
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
      if (!isBrowserRouteGuestPopup(window.webContents.id)) {
        this.attachPopupGuestPolicies(
          window.webContents,
          this.resolvePopupOwnerContext(guest.id),
          this.pageIdForGuest(guest.id)
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

      // A server page's popup (or one opened by a paired mobile viewer) reaches its viewer as a tab, never flashing on the host screen.
      // Hidden, not offscreen: Electron never sizes or paints an offscreen window.open child (electron/electron#55565).
      const shownToViewers = this.isPopupShownToViewers(guest.id, browserTabId, observed)
      // Only the desktop user's own click may bring a popup forward; agents and late opens wait.
      const showWhenAppActive = !shownToViewers && observed?.byAgent !== false
      // Native popups must not target local files.
      const canOpenAsChild = normalizeBrowserPopupUrl(url) !== null
      if (browserTabId && canOpenAsChild) {
        return allowManagedGuestPopupWindow({
          opener: guest,
          url,
          disposition,
          features,
          frameName,
          shownToViewers,
          showWhenAppActive,
          canPresent: () => Boolean(this.resolvePopupOwnerContext(guest.id)),
          tryOpenAsTabWithoutOpener: (childOpener) =>
            this.openNewTabPopup(guest, request, observed, childOpener),
          createChildWindow: (options) =>
            this.createPopupChildWindowWithOriginBar(guest, url, options)
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
    owner: PopupOwnerContext | null,
    immediateOpenerPageId?: string
  ): void {
    const fresh = !this.policyAttachedGuestIds.has(contents.id)
    this.attachGuestPolicies(contents, owner)
    if (fresh) {
      watchBrowserPopupSiteFrameRemoval(contents)
      if (owner && this.isPopupShownToViewers(contents.id, owner.browserTabId)) {
        this.publishServerPagePopup(contents, owner, immediateOpenerPageId)
      }
    }
  }

  isRoutePopupShownToViewers(
    openerWebContentsId: number,
    observed?: ObservedBrowserGuestGesture | null
  ): boolean {
    const browserTabId = this.resolvePopupOwnerContext(openerWebContentsId)?.browserTabId ?? null
    return this.isPopupShownToViewers(openerWebContentsId, browserTabId, observed)
  }

  publishRouteGuestPopup(
    openerGuest: Electron.WebContents,
    popupContents: Electron.WebContents
  ): void {
    const owner = this.resolvePopupOwnerContext(openerGuest.id)
    if (owner && this.isPopupShownToViewers(openerGuest.id, owner.browserTabId)) {
      this.publishServerPagePopup(popupContents, owner, this.pageIdForGuest(openerGuest.id))
    }
  }

  private isPopupShownToViewers(
    guestWebContentsId: number,
    browserTabId: string | null,
    observed?: ObservedBrowserGuestGesture | null
  ): boolean {
    return isPopupShownToPairedViewers({
      isListedAsServerPage: this.isListedAsServerPage(guestWebContentsId),
      browserTabId,
      immediatePageId: this.pageIdForGuest(guestWebContentsId),
      peekCreditDeviceId: (tabId) => this.pageInputCredit.peek(tabId),
      observed
    })
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
    immediateOpenerPageId?: string
  ): void {
    publishBrowserPopupToViewers({
      contents,
      owner,
      worktreeId: this.worktreeIdByTabId.get(owner.browserTabId),
      immediateOpenerPageId,
      consumePairedDeviceId: (browserTabId) => this.pageInputCredit.consume(browserTabId),
      presentPopup: this.serverPagePopupPresenter,
      closePopup: this.serverPagePopupCloser,
      notifyGuestStateChanged: (worktreeId) =>
        this.notifyWorktreeBrowserGuestStateChanged(worktreeId)
    })
  }

  protected createPopupChildWindowWithOriginBar(
    openerGuest: Electron.WebContents,
    targetUrl: string,
    options: PopupChildWindowOptions
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
        this.attachPopupGuestPolicies(contents, owner, this.pageIdForGuest(openerGuest.id))
        this.inheritAgentLead(openerGuest.id, contents.id)
        return true
      },
      openerTabId: this.resolveBrowserTabIdForGuestWebContentsId(openerGuest.id),
      forwardPopupEvent: (guestId, event) => this.forwardOrQueuePopupEvent(guestId, event),
      emitPageEvent: (tabId, event) => this.pageEvents.emit(tabId, event)
    })
  }
}

// Web pages must not reach the filesystem; only a local page may link to local files.
export function isLocalFileLinkFromLocalPage(guest: Electron.WebContents, url: string): boolean {
  return url.startsWith('file:') && guest.getURL().startsWith('file:')
}

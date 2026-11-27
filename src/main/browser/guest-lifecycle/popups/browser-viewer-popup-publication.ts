import {
  isBrowserTabPopupRequest,
  isNewBrowserTabPopupIntent,
  waitsForPopupOpener,
  type NewBrowserTabPopupRequest
} from './browser-popup-new-tab-intent'
import { normalizeExternalBrowserUrl } from '../../../../shared/browser/navigation/browser-url'
import { safeOrigin } from '../browser-event-origin'
import type { ObservedBrowserGuestGesture } from '../input/browser-guest-input-gesture'
import type { BrowserPageEvent } from '../page-activity/browser-page-events'
import type {
  PopupOwnerContext,
  ServerPagePopupClosure,
  ServerPagePopupPresentation
} from './browser-popup-ownership'
import { browserPopupPageId } from './browser-popup-page-id'
import {
  allowNativeBrowserPopup,
  isNativeBrowserPopupRequest
} from './presentation/browser-popup-native-window'
import type { PopupChildWindowOptions } from './presentation/browser-popup-window-contract'
import { SAFE_POPUP_WINDOW_OPTIONS } from './presentation/browser-popup-window-policy'
import {
  discardPopupChildWindow,
  openPopupWithOriginBar,
  popupChildOpener
} from './presentation/popup-origin-bar-window'
import { installBrowserJavaScriptDialogs } from '../prompts/browser-javascript-dialogs'
import {
  addBrowserPopupViewer,
  getActiveBrowserPopupViewer,
  hasActiveBrowserScreencastViewer,
  markHiddenPopupGuest,
  unmarkHiddenPopupGuest
} from './browser-popup-viewer-registry'

export { addBrowserPopupViewer, getActiveBrowserPopupViewer, hasActiveBrowserScreencastViewer }

export type PopupViewerTarget = {
  shownToViewers: boolean
  pairedDeviceId: string | null
}

/** Decides once at window-open time whether this popup belongs to paired viewers and which device follows it. */
export function resolvePopupViewerTarget(input: {
  isListedAsServerPage: boolean
  browserTabId: string | null
  immediatePageId?: string
  peekCreditDeviceId: (browserTabId: string) => string | null
  observed?: ObservedBrowserGuestGesture | null
}): PopupViewerTarget {
  if (!input.isListedAsServerPage && input.observed?.fromThisDesktop) {
    return { shownToViewers: false, pairedDeviceId: null }
  }
  if (input.observed?.byAgent === true && input.observed.fromPairedViewer !== true) {
    // An agent CLI must not pull a passive phone viewer onto its popup, even on a server page.
    return { shownToViewers: input.isListedAsServerPage, pairedDeviceId: null }
  }
  const pairedDeviceId =
    (input.browserTabId !== null ? input.peekCreditDeviceId(input.browserTabId) : null) ??
    getActiveBrowserPopupViewer(input.immediatePageId) ??
    getActiveBrowserPopupViewer(input.browserTabId)
  return {
    shownToViewers: input.isListedAsServerPage || pairedDeviceId !== null,
    pairedDeviceId
  }
}

// Lists a popup as a viewer tab and returns the opening paired client to its opener on close.
export function publishBrowserPopupToViewers(input: {
  contents: Electron.WebContents
  owner: PopupOwnerContext
  worktreeId: string | undefined
  immediateOpenerPageId?: string
  pairedDeviceId: string | null
  presentPopup: ((popup: ServerPagePopupPresentation) => void) | null
  closePopup: ((popup: ServerPagePopupClosure) => Promise<void> | void) | null
  notifyGuestStateChanged: (worktreeId: string) => void
}): void {
  const { contents, owner, worktreeId, immediateOpenerPageId, pairedDeviceId } = input
  if (!worktreeId) {
    return
  }
  // Hidden on the host, so its viewers and agents answer its dialogs, as for a server page.
  markHiddenPopupGuest(contents.id)
  installBrowserJavaScriptDialogs(contents, () => null)
  const browserPageId = browserPopupPageId(contents.id)
  const openerBrowserPageId = immediateOpenerPageId ?? owner.browserTabId
  contents.once('destroyed', () => {
    unmarkHiddenPopupGuest(contents.id)
    if (pairedDeviceId && input.closePopup) {
      // Switch the paired client back to its opener before broadcasting removal so it never snaps elsewhere first.
      void Promise.resolve(
        input.closePopup({
          worktreeId,
          browserPageId,
          openerBrowserPageId,
          ...(openerBrowserPageId !== owner.browserTabId
            ? { fallbackOpenerBrowserPageId: owner.browserTabId }
            : {}),
          pairedDeviceId
        })
      )
        .catch(() => {})
        .finally(() => input.notifyGuestStateChanged(worktreeId))
      return
    }
    input.notifyGuestStateChanged(worktreeId)
  })
  input.notifyGuestStateChanged(worktreeId)
  if (pairedDeviceId) {
    input.presentPopup?.({ worktreeId, browserPageId, pairedDeviceId })
  }
}

export function allowManagedGuestPopupWindow(input: {
  opener: Electron.WebContents
  url: string
  disposition: string
  features: string
  frameName: string
  shownToViewers: boolean
  showWhenAppActive: boolean
  canPresent: () => boolean
  tryOpenAsTabWithoutOpener: (childOpener: Electron.WebFrameMain | null) => boolean
  createChildWindow: (options: PopupChildWindowOptions) => Electron.WebContents
}): Electron.WindowOpenHandlerResponse {
  const openAsTabWithoutOpener = (options: PopupChildWindowOptions): Electron.WebContents | null =>
    input.tryOpenAsTabWithoutOpener(popupChildOpener(options))
      ? discardPopupChildWindow(options, input.url)
      : null
  const windowOptions = input.shownToViewers
    ? { ...SAFE_POPUP_WINDOW_OPTIONS, show: false }
    : SAFE_POPUP_WINDOW_OPTIONS
  const showWhenAppActive = !input.shownToViewers && input.showWhenAppActive
  if (
    isNativeBrowserPopupRequest({
      disposition: input.disposition,
      features: input.features,
      frameName: input.frameName
    })
  ) {
    return allowNativeBrowserPopup({
      opener: input.opener,
      options: windowOptions,
      background: input.disposition === 'background-tab',
      showWhenAppActive,
      canPresent: input.canPresent,
      onCreated: (options) => openAsTabWithoutOpener(options) ?? input.createChildWindow(options)
    })
  }
  // Restrict page-requested chrome so native popups remain verifiable and escapable.
  return {
    action: 'allow',
    overrideBrowserWindowOptions: windowOptions,
    // Host child windows with an origin bar so users can verify the destination.
    createWindow: (options: PopupChildWindowOptions) =>
      openAsTabWithoutOpener(options) ??
      input.createChildWindow({
        ...options,
        ...(input.shownToViewers ? { show: false } : {}),
        showWhenAppActive,
        // Bind link-created contents to the opener's session.
        webPreferences: { ...options.webPreferences, session: input.opener.session }
      })
  }
}

export function openManagedPopupChildWindow(input: {
  openerGuest: Electron.WebContents
  targetUrl: string
  options: PopupChildWindowOptions
  prepareContent: (contents: Electron.WebContents) => boolean
  openerTabId: string | null
  forwardPopupEvent: (
    guestWebContentsId: number,
    event: { origin: string; action: 'blocked' | 'opened-in-orca' | 'opened-external' }
  ) => void
  emitPageEvent: (browserTabId: string, event: BrowserPageEvent) => void
}): Electron.WebContents {
  const { openerGuest, targetUrl, options } = input
  const popup = openPopupWithOriginBar(options, targetUrl, input.prepareContent)
  const opened = Boolean(options.webContents || options.nativeWindow)
  input.forwardPopupEvent(openerGuest.id, {
    origin: safeOrigin(targetUrl),
    action: opened ? 'opened-in-orca' : 'blocked'
  })
  if (opened && input.openerTabId) {
    input.emitPageEvent(input.openerTabId, {
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

// Web pages must not reach the filesystem; only a local page may link to local files.
export function isLocalFileLinkFromLocalPage(guest: Electron.WebContents, url: string): boolean {
  return url.startsWith('file:') && guest.getURL().startsWith('file:')
}

/** Answers a new-tab request as an Orca tab; false leaves opener-dependent requests to a child window. */
export function openManagedGuestNewTabPopup(input: {
  guest: Electron.WebContents
  ownerContext: PopupOwnerContext | null
  request: NewBrowserTabPopupRequest
  observed: ObservedBrowserGuestGesture | null
  childOpener?: Electron.WebFrameMain | null
  tryConsumePageInitiatedTab: (rootGuestId: number) => boolean
  isAwaitingDownloadFrom: (guestId: number, rootGuestId: number) => boolean
  isAgentLeadingGuest: (guestId: number) => boolean
  openLinkInOrcaTab: (
    browserTabId: string,
    url: string,
    activate: boolean,
    agentOpened: boolean
  ) => boolean
  forwardPopupEvent: (
    guestId: number,
    event: { origin: string; action: 'blocked' | 'opened-in-orca' | 'opened-external' }
  ) => void
}): boolean {
  const { guest, ownerContext, request, observed, childOpener } = input
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
  if (!observed && !input.tryConsumePageInitiatedTab(ownerContext.rootGuestWebContentsId)) {
    input.forwardPopupEvent(guest.id, { origin: safeOrigin(newTabUrl), action: 'blocked' })
    return true
  }
  if (input.isAwaitingDownloadFrom(guest.id, ownerContext.rootGuestWebContentsId)) {
    guest.downloadURL(newTabUrl)
    return true
  }
  const agentOpened = observed?.byAgent !== false && input.isAgentLeadingGuest(guest.id)
  if (
    input.openLinkInOrcaTab(
      ownerContext.browserTabId,
      newTabUrl,
      request.disposition !== 'background-tab',
      agentOpened
    )
  ) {
    input.forwardPopupEvent(guest.id, { origin: safeOrigin(newTabUrl), action: 'opened-in-orca' })
  }
  // A vanished renderer must not turn new-tab intent into a native popup.
  return true
}

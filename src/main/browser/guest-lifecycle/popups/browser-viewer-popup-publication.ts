import { safeOrigin } from '../browser-event-origin'
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

// Lists a popup as a viewer tab and returns the opening paired client to its opener on close.
export function publishBrowserPopupToViewers(input: {
  contents: Electron.WebContents
  owner: PopupOwnerContext
  worktreeId: string | undefined
  immediateOpenerPageId?: string
  consumePairedDeviceId: (browserTabId: string) => string | null
  presentPopup: ((popup: ServerPagePopupPresentation) => void) | null
  closePopup: ((popup: ServerPagePopupClosure) => Promise<void> | void) | null
  notifyGuestStateChanged: (worktreeId: string) => void
}): void {
  const { contents, owner, worktreeId, immediateOpenerPageId } = input
  if (!worktreeId) {
    return
  }
  // Hidden on the host, so its viewers and agents answer its dialogs, as for a server page.
  installBrowserJavaScriptDialogs(contents, () => null)
  const browserPageId = browserPopupPageId(contents.id)
  const pairedDeviceId = input.consumePairedDeviceId(owner.browserTabId)
  const openerBrowserPageId = immediateOpenerPageId ?? owner.browserTabId
  contents.once('destroyed', () => {
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
  if (
    isNativeBrowserPopupRequest({
      disposition: input.disposition,
      features: input.features,
      frameName: input.frameName
    })
  ) {
    return allowNativeBrowserPopup({
      opener: input.opener,
      options: input.shownToViewers
        ? { ...SAFE_POPUP_WINDOW_OPTIONS, show: false }
        : SAFE_POPUP_WINDOW_OPTIONS,
      background: input.disposition === 'background-tab',
      showWhenAppActive: input.showWhenAppActive,
      canPresent: input.canPresent,
      onCreated: (options) => openAsTabWithoutOpener(options) ?? input.createChildWindow(options)
    })
  }
  // Restrict page-requested chrome so native popups remain verifiable and escapable.
  return {
    action: 'allow',
    overrideBrowserWindowOptions: SAFE_POPUP_WINDOW_OPTIONS,
    // Host child windows with an origin bar so users can verify the destination.
    createWindow: (options: PopupChildWindowOptions) =>
      openAsTabWithoutOpener(options) ??
      input.createChildWindow({
        ...options,
        ...(input.shownToViewers ? { show: false } : {}),
        showWhenAppActive: input.showWhenAppActive,
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

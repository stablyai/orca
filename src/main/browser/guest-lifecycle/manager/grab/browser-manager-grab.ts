import { webContents } from 'electron'
import { buildGuestOverlayScript } from '../../../element-grab/grab-guest-script'
import { buildGrabLabelAvoidScript } from '../../../element-grab/grab-guest-overlay-script'
import {
  GuestEditableWatch,
  askGuestHasField,
  isSelectorPresentInGuest
} from '../../../element-grab/grab-guest-editable-watch'
import { clampGrabPayload } from '../../../element-grab/browser-grab-payload'
import { captureSelectionScreenshot as captureGrabSelectionScreenshot } from '../../../element-grab/browser-grab-screenshot'
import {
  getWorkspaceDocPageGuest,
  readDocPreviewGuestDocumentUrl
} from '../../../document-preview/doc-preview-guest-policy'
import type {
  BrowserGrabCancelReason,
  BrowserGrabResult,
  BrowserGrabRect,
  BrowserGrabPayload,
  BrowserGrabScreenshot,
  BrowserGrabLabelAvoidArea
} from '../../../../../shared/browser/element-grab/browser-grab-types'
import { BrowserManagerViewport } from '../viewport/browser-manager-viewport'

// Electron's executeJavaScript waits for did-stop-loading, so a guest destroyed mid-load never settles it.
function runOverlayScript(guest: Electron.WebContents, mode: 'arm' | 'teardown'): Promise<boolean> {
  return new Promise((resolve) => {
    const settle = (ran: boolean): void => {
      guest.off('destroyed', onDestroyed)
      resolve(ran)
    }
    const onDestroyed = (): void => settle(false)
    guest.once('destroyed', onDestroyed)
    guest.executeJavaScript(buildGuestOverlayScript(mode)).then(
      () => settle(true),
      () => settle(false)
    )
  })
}

// Removing the overlay from the DOM is not yet a painted frame without it; on a busy page the next capture can still
// show the old frame. Two animation frames mean a frame was produced after the removal. The cap keeps a throttled or
// frozen page from stalling the caller.
const PAINTED_FRAME_SCRIPT = `new Promise((resolve) => {
  let done = false
  const finish = () => { if (!done) { done = true; resolve(true) } }
  requestAnimationFrame(() => requestAnimationFrame(finish))
  setTimeout(finish, 500)
})`

function waitForPaintedFrame(guest: Electron.WebContents): Promise<void> {
  if (guest.isDestroyed()) {
    return Promise.resolve()
  }
  return guest.executeJavaScript(PAINTED_FRAME_SCRIPT).then(
    () => {},
    () => {}
  )
}

// Fire-and-forget: a page that is gone or mid-navigation simply has no picker to tell.
function sendLabelAvoidArea(
  guest: Electron.WebContents,
  area: BrowserGrabLabelAvoidArea | null
): void {
  if (guest.isDestroyed()) {
    return
  }
  guest.executeJavaScript(buildGrabLabelAvoidScript(area)).catch(() => {})
}

export abstract class BrowserManagerGrab extends BrowserManagerViewport {
  /** The annotate palette's footprint per page, re-sent to each newly armed picker. */
  private readonly grabLabelAvoidAreaByTabId = new Map<string, BrowserGrabLabelAvoidArea>()
  /** Per page, the current pick's view of whether a page field has focus. */
  private readonly editableWatchByTabId = new Map<string, GuestEditableWatch>()

  /** True while a page field may have focus during a pick (unknown counts as true), so letters stay with it. */
  isGuestEditableFocused(browserTabId: string): boolean {
    return this.editableWatchByTabId.get(browserTabId)?.editable ?? true
  }

  /** A key that can move focus (Tab) reached the page; its field state is unknown until the page reports again. */
  markGuestFocusUnknown(browserTabId: string): void {
    this.editableWatchByTabId.get(browserTabId)?.markUnknown()
  }

  /** Asks the page now whether a field has focus; anything but a clear "no" counts as a field. */
  askPageHasField(browserTabId: string): Promise<boolean> {
    const guestId = this.webContentsIdByTabId.get(browserTabId)
    const guest = guestId === undefined ? null : webContents.fromId(guestId)
    return guest ? askGuestHasField(guest) : Promise.resolve(true)
  }

  isGrabSelectorPresent(selector: string, guest: Electron.WebContents): Promise<boolean> {
    return isSelectorPresentInGuest(guest, selector)
  }

  private stopEditableWatch(browserTabId: string): void {
    this.editableWatchByTabId.get(browserTabId)?.stop()
    this.editableWatchByTabId.delete(browserTabId)
  }

  private watchGuestEditable(browserTabId: string, guest: Electron.WebContents): void {
    this.stopEditableWatch(browserTabId)
    const watch = new GuestEditableWatch(guest)
    this.editableWatchByTabId.set(browserTabId, watch)
    watch.start()
  }

  setGrabLabelAvoidArea(
    browserTabId: string,
    area: BrowserGrabLabelAvoidArea | null,
    guest: Electron.WebContents | null
  ): void {
    if (area) {
      this.grabLabelAvoidAreaByTabId.set(browserTabId, area)
    } else {
      this.grabLabelAvoidAreaByTabId.delete(browserTabId)
    }
    if (guest) {
      sendLabelAvoidArea(guest, area)
    }
  }

  /** Authorize tools for browsing and document guests; documents stay outside browsing maps. */
  getAuthorizedGuest(
    browserTabId: string,
    senderWebContentsId: number
  ): Electron.WebContents | null {
    const docGuest = getWorkspaceDocPageGuest(browserTabId, senderWebContentsId)
    if (docGuest) {
      return docGuest
    }
    const registeredRenderer = this.rendererWebContentsIdByTabId.get(browserTabId)
    if (registeredRenderer == null || registeredRenderer !== senderWebContentsId) {
      return null
    }
    const guestId = this.webContentsIdByTabId.get(browserTabId)
    if (guestId == null) {
      return null
    }
    const guest = webContents.fromId(guestId)
    if (!guest || guest.isDestroyed()) {
      // Clear every per-tab entry when a guest is stale.
      this.unregisterGuest(browserTabId)
      return null
    }
    return guest
  }

  hasActiveGrabOp(browserTabId: string): boolean {
    return this.grabSessionController.hasActiveGrabOp(browserTabId)
  }

  async setGrabMode(
    browserTabId: string,
    enabled: boolean,
    guest: Electron.WebContents
  ): Promise<boolean> {
    if (!enabled) {
      this.stopEditableWatch(browserTabId)
      this.cancelGrabOp(browserTabId, 'user')
      // Why always await a teardown, also right after cancelling a running pick: the page runs scripts in order, so
      // this settles only once the cancelled pick's own teardown has run too. Draw captures the page after this
      // resolves and must never freeze the picker's highlight into the screenshot.
      const tornDown = await runOverlayScript(guest, 'teardown')
      if (tornDown) {
        await waitForPaintedFrame(guest)
      }
      return tornDown
    }
    // Arm eagerly so hover feedback appears before selection starts.
    const armed = await runOverlayScript(guest, 'arm')
    const area = this.grabLabelAvoidAreaByTabId.get(browserTabId)
    if (armed && area) {
      sendLabelAvoidArea(guest, area)
    }
    if (armed) {
      this.watchGuestEditable(browserTabId, guest)
    }
    return armed
  }

  awaitGrabSelection(
    browserTabId: string,
    opId: string,
    guest: Electron.WebContents
  ): Promise<BrowserGrabResult> {
    return this.grabSessionController.awaitGrabSelection(browserTabId, opId, guest)
  }

  cancelGrabOp(browserTabId: string, reason: BrowserGrabCancelReason): void {
    this.grabSessionController.cancelGrabOp(browserTabId, reason)
  }

  async captureSelectionScreenshot(
    _browserTabId: string,
    rect: BrowserGrabRect,
    guest: Electron.WebContents
  ): Promise<BrowserGrabScreenshot | null> {
    const releasePaint = this.holdPaintForCapture(guest.id)
    try {
      return await captureGrabSelectionScreenshot(rect, guest)
    } finally {
      releasePaint()
    }
  }

  /** Preserve the active selection overlay and awaitClick listener. */
  async extractHoverPayload(
    _browserTabId: string,
    guest: Electron.WebContents
  ): Promise<BrowserGrabPayload | null> {
    try {
      const rawPayload = await guest.executeJavaScript(buildGuestOverlayScript('extractHover'))
      if (!rawPayload || typeof rawPayload !== 'object') {
        return null
      }
      return clampGrabPayload(rawPayload, readDocPreviewGuestDocumentUrl(guest))
    } catch {
      return null
    }
  }
}

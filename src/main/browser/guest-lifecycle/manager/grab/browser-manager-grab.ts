import { webContents } from 'electron'
import { buildGuestOverlayScript } from '../../../element-grab/grab-guest-script'
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
  BrowserGrabScreenshot
} from '../../../../../shared/browser/element-grab/browser-grab-types'
import { BrowserManagerViewport } from '../viewport/browser-manager-viewport'

// A guest no arm ever reached has no overlay to remove, so its teardown never waits behind a page load.
const armedGuests = new WeakSet<Electron.WebContents>()
// Torn down, but not yet seen painting a frame without the overlay.
const unpaintedTeardowns = new WeakSet<Electron.WebContents>()

/** Whether a capture must first see the guest paint without the picker; false if no overlay could still show. */
export function grabCaptureNeedsPaintProof(guest: Electron.WebContents): boolean {
  return armedGuests.has(guest) || unpaintedTeardowns.has(guest)
}

export function markGrabPaintProven(guest: Electron.WebContents): void {
  unpaintedTeardowns.delete(guest)
}

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

export abstract class BrowserManagerGrab extends BrowserManagerViewport {
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
      this.cancelGrabOp(browserTabId, 'user')
      // A cancelled op only queues its teardown; awaiting this idempotent one after it means "off" is off in the page.
      if (!armedGuests.has(guest)) {
        return true
      }
      const removed = await runOverlayScript(guest, 'teardown')
      if (removed) {
        armedGuests.delete(guest)
        unpaintedTeardowns.add(guest)
      }
      return removed
    }
    armedGuests.add(guest)
    // Arm eagerly so hover feedback appears before selection starts.
    return runOverlayScript(guest, 'arm')
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

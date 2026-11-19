import { webContents } from 'electron'
import { buildGuestOverlayScript } from '../../../element-grab/grab-guest-script'
import { buildGrabLabelAvoidScript } from '../../../element-grab/grab-guest-overlay-script'
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
  /** Whether a page field has focus during the current pick, as the armed picker last reported. */
  private readonly guestEditableByTabId = new Map<string, boolean>()
  private readonly editableWatchByTabId = new Map<string, number>()
  private editableWatchSeq = 0

  isGuestEditableFocused(browserTabId: string): boolean {
    return this.guestEditableByTabId.get(browserTabId) ?? false
  }

  /**
   * Follows the armed picker's focus report for the whole pick (Tab, page script, shadow roots, frames), so a bare
   * letter typed into a page field stays with the field. Ends when the picker is torn down or re-armed.
   */
  private watchGuestEditable(browserTabId: string, guest: Electron.WebContents): void {
    const watch = ++this.editableWatchSeq
    this.editableWatchByTabId.set(browserTabId, watch)
    this.guestEditableByTabId.delete(browserTabId)
    const isCurrent = (): boolean => this.editableWatchByTabId.get(browserTabId) === watch
    const step = (lastSeen: boolean | null): void => {
      if (!isCurrent() || guest.isDestroyed()) {
        return
      }
      guest
        .executeJavaScript(
          `(function() { var g = window.__orcaGrab; return g && g.awaitEditable ? g.awaitEditable(${JSON.stringify(lastSeen)}) : null; })()`
        )
        .then(
          (editable: unknown) => {
            if (!isCurrent()) {
              return
            }
            if (typeof editable !== 'boolean') {
              this.guestEditableByTabId.delete(browserTabId)
              this.editableWatchByTabId.delete(browserTabId)
              return
            }
            this.guestEditableByTabId.set(browserTabId, editable)
            step(editable)
          },
          () => {
            if (isCurrent()) {
              this.guestEditableByTabId.delete(browserTabId)
              this.editableWatchByTabId.delete(browserTabId)
            }
          }
        )
    }
    step(null)
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
      this.editableWatchByTabId.delete(browserTabId)
      this.guestEditableByTabId.delete(browserTabId)
      this.cancelGrabOp(browserTabId, 'user')
      // Why always await a teardown, also right after cancelling a running pick: the page runs scripts in order, so
      // this settles only once the cancelled pick's own teardown has run too. Draw captures the page after this
      // resolves and must never freeze the picker's highlight into the screenshot.
      return runOverlayScript(guest, 'teardown')
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

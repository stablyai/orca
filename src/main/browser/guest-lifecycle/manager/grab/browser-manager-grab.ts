import { isAgentInjectingInput } from '../../../cdp/input/agent-input-injection'
import { GrabNativeKeySession } from '../../../element-grab/grab-native-key-session'
import { isPickedElementPresent } from '../../../element-grab/grab-picked-element'
import { webContents } from 'electron'
import { executeGrabScript, requestGrabExecution } from '../../../element-grab/grab-guest-execution'
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

function runOverlayScript(
  guest: Electron.WebContents,
  mode: 'arm' | 'teardown',
  signal?: AbortSignal
): Promise<boolean | null> {
  return executeGrabScript(guest, buildGuestOverlayScript(mode), { signal })
}

// A stalled or throttled renderer has not established a clean frame: fail rather than capture old pixels.
const PAINTED_FRAME_SCRIPT = `new Promise((resolve) => {
  let done = false
  const finish = (painted) => { if (!done) { done = true; resolve(painted) } }
  requestAnimationFrame(() => requestAnimationFrame(() => finish(true)))
  setTimeout(() => finish(false), 500)
})`

function waitForPaintedFrame(
  guest: Electron.WebContents,
  signal?: AbortSignal
): Promise<boolean | null> {
  return executeGrabScript(guest, PAINTED_FRAME_SCRIPT, { signal })
}

// Fire-and-forget: a page that is gone or mid-navigation simply has no picker to tell.
async function sendLabelAvoidArea(
  guest: Electron.WebContents,
  area: BrowserGrabLabelAvoidArea | null
): Promise<boolean> {
  if (guest.isDestroyed()) {
    return false
  }
  return (await executeGrabScript(guest, buildGrabLabelAvoidScript(area))) === true
}

export abstract class BrowserManagerGrab extends BrowserManagerViewport {
  /** The annotate palette's footprint per page, re-sent to each newly armed picker. */
  private readonly grabLabelAvoidAreaByTabId = new Map<
    string,
    { area: BrowserGrabLabelAvoidArea; rendererWebContentsId: number }
  >()
  /** Private preload key ownership for the current document and hosting renderer. */
  private readonly nativeKeysByTabId = new Map<string, GrabNativeKeySession>()
  isGrabPickedElementPresent(
    selectionId: string,
    guest: Electron.WebContents,
    interactive = false
  ): Promise<boolean | null> {
    return isPickedElementPresent(guest, selectionId, interactive)
  }

  async setGrabLabelAvoidArea(
    browserTabId: string,
    area: BrowserGrabLabelAvoidArea | null,
    rendererWebContentsId: number
  ): Promise<boolean> {
    const guest = this.getAuthorizedGuest(browserTabId, rendererWebContentsId)
    const retained = this.grabLabelAvoidAreaByTabId.get(browserTabId)
    // Guest loss permits only its recorded owner to clear the retained footprint.
    if (!guest && (area !== null || retained?.rendererWebContentsId !== rendererWebContentsId)) {
      return false
    }
    if (area) {
      this.grabLabelAvoidAreaByTabId.set(browserTabId, { area, rendererWebContentsId })
    } else {
      this.grabLabelAvoidAreaByTabId.delete(browserTabId)
    }
    if (guest) {
      return sendLabelAvoidArea(guest, area)
    }
    return true
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
    guest: Electron.WebContents,
    host?: Electron.WebContents,
    canDeliver?: () => boolean,
    signal?: AbortSignal
  ): Promise<boolean> {
    if (signal?.aborted || canDeliver?.() === false) {
      return false
    }
    this.nativeKeysByTabId.get(browserTabId)?.stop()
    this.nativeKeysByTabId.delete(browserTabId)
    if (!enabled) {
      this.cancelGrabOp(browserTabId, 'user')
      // Why always await a teardown, also right after cancelling a running pick: the page runs scripts in order, so
      // this settles only once the cancelled pick's own teardown has run too. Draw captures the page after this
      // resolves and must never freeze the picker's highlight into the screenshot.
      const tornDown = await runOverlayScript(guest, 'teardown', signal)
      return tornDown === true && (await waitForPaintedFrame(guest, signal)) === true
    }
    // Arm eagerly so hover feedback appears before selection starts.
    const armed = await runOverlayScript(guest, 'arm', signal)
    if (signal?.aborted || canDeliver?.() === false) {
      if (armed) {
        void runOverlayScript(guest, 'teardown')
      }
      return false
    }
    const area = this.grabLabelAvoidAreaByTabId.get(browserTabId)?.area
    if (armed && area) {
      if (!(await sendLabelAvoidArea(guest, area))) {
        return false
      }
    }
    if (armed) {
      if (host) {
        const keys = new GrabNativeKeySession(
          guest,
          host,
          browserTabId,
          () => {
            if (this.nativeKeysByTabId.get(browserTabId) === keys) {
              this.nativeKeysByTabId.delete(browserTabId)
            }
          },
          canDeliver
        )
        this.nativeKeysByTabId.set(browserTabId, keys)
        if (!(await keys.setEnabled(!isAgentInjectingInput(guest)))) {
          keys.stop()
          if (this.nativeKeysByTabId.get(browserTabId) === keys) {
            this.nativeKeysByTabId.delete(browserTabId)
          }
          return false
        }
      }
    }
    return armed === true
  }

  async awaitGrabSelection(
    browserTabId: string,
    opId: string,
    guest: Electron.WebContents
  ): Promise<BrowserGrabResult> {
    const keys = this.nativeKeysByTabId.get(browserTabId)
    const result = await this.grabSessionController.awaitGrabSelection(browserTabId, opId, guest)
    if (
      result.kind !== 'selected' &&
      result.kind !== 'context-selected' &&
      !this.grabSessionController.hasActiveGrabOp(browserTabId) &&
      this.nativeKeysByTabId.get(browserTabId) === keys
    ) {
      keys?.stop()
      this.nativeKeysByTabId.delete(browserTabId)
    }
    return result
  }

  cancelGrabOp(browserTabId: string, reason: BrowserGrabCancelReason): void {
    this.nativeKeysByTabId.get(browserTabId)?.stop()
    this.nativeKeysByTabId.delete(browserTabId)
    if (reason === 'evicted' || reason === 'navigation') {
      this.grabLabelAvoidAreaByTabId.delete(browserTabId)
    }
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
      const execution = await requestGrabExecution(guest, buildGuestOverlayScript('extractHover'))
      if (!execution.ok) {
        return null
      }
      const rawPayload = execution.value
      if (!rawPayload || typeof rawPayload !== 'object') {
        return null
      }
      return clampGrabPayload(rawPayload, readDocPreviewGuestDocumentUrl(guest))
    } catch {
      return null
    }
  }
}

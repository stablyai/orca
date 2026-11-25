import {
  isAgentInjectingKeyboard,
  recoverBrowserInputGuard
} from '../../../cdp/input/agent-input-injection'
import { GrabNativeKeySession } from '../../../element-grab/grab-native-key-session'
import { isPickedElementPresent } from '../../../element-grab/grab-picked-element'
import { webContents } from 'electron'
import {
  executeGrabScript,
  requestGrabExecution,
  grabDocumentScope,
  retireGrabOverlay,
  whenGrabScriptLaneIdle,
  type GrabDocumentScope
} from '../../../element-grab/grab-guest-execution'
import { GRAB_GUEST_ARM_SCRIPT } from '../../../element-grab/grab-guest-script'
import { clampGrabPayload } from '../../../element-grab/browser-grab-payload'
import { captureSelectionScreenshot as captureGrabSelectionScreenshot } from '../../../element-grab/browser-grab-screenshot'
import { captureCleanDocumentPage } from '../../../element-grab/grab-clean-page-capture'
import type { BrowserCleanPageCapture } from '../../../../../shared/browser/element-grab/browser-grab-clean-capture'
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
  signal?: AbortSignal,
  scope = grabDocumentScope(guest)
): Promise<boolean | null> {
  return executeGrabScript(guest, mode === 'arm' ? GRAB_GUEST_ARM_SCRIPT : '', {
    signal,
    scope,
    overlayControl: mode === 'arm',
    clean: mode === 'teardown'
  })
}

// Fire-and-forget: a page that is gone or mid-navigation simply has no picker to tell.
async function sendLabelAvoidArea(
  guest: Electron.WebContents,
  area: BrowserGrabLabelAvoidArea | null,
  scope?: GrabDocumentScope
): Promise<boolean> {
  if (guest.isDestroyed()) {
    return false
  }
  return (
    (await executeGrabScript(guest, '', {
      background: true,
      scope,
      overlayAction: { action: 'setLabelAvoidArea', argument: area }
    })) === true
  )
}

const LABEL_SYNC_ATTEMPTS = 4

type LabelSync = {
  guest: Electron.WebContents
  scope: GrabDocumentScope
  dirty: boolean
  done: Promise<boolean>
}

export abstract class BrowserManagerGrab extends BrowserManagerViewport {
  /** One advisory footprint delivery per page; a newer footprint joins it instead of racing it. */
  private readonly labelSyncByTabId = new Map<string, LabelSync>()
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
      return this.syncLabelAvoidArea(browserTabId, guest, grabDocumentScope(guest))
    }
    return true
  }

  /** Busy execution delays the footprint instead of failing it; each attempt reads the newest one. */
  private syncLabelAvoidArea(
    browserTabId: string,
    guest: Electron.WebContents,
    scope: GrabDocumentScope
  ): Promise<boolean> {
    const running = this.labelSyncByTabId.get(browserTabId)
    if (running && running.guest === guest && running.scope === scope) {
      running.dirty = true
      return running.done
    }
    const sync: LabelSync = { guest, scope, dirty: true, done: Promise.resolve(false) }
    this.labelSyncByTabId.set(browserTabId, sync)
    const isCurrent = (): boolean => this.labelSyncByTabId.get(browserTabId) === sync
    sync.done = (async (): Promise<boolean> => {
      // Starts after the caller's synchronous turn so a footprint set in the same turn joins this attempt.
      await Promise.resolve()
      let applied = false
      for (let attempt = 0; sync.dirty && attempt < LABEL_SYNC_ATTEMPTS && isCurrent(); attempt++) {
        sync.dirty = false
        const area = this.grabLabelAvoidAreaByTabId.get(browserTabId)?.area ?? null
        applied = await sendLabelAvoidArea(guest, area, scope)
        if (!applied && !guest.isDestroyed() && scope.current) {
          sync.dirty = true
          await whenGrabScriptLaneIdle(guest)
        }
      }
      if (isCurrent()) {
        this.labelSyncByTabId.delete(browserTabId)
      }
      return applied
    })()
    return sync.done
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
    signal?: AbortSignal,
    onUnavailable?: () => void,
    paletteKeys = true
  ): Promise<boolean> {
    if (signal?.aborted || canDeliver?.() === false) {
      return false
    }
    const scope = grabDocumentScope(guest)
    this.nativeKeysByTabId.get(browserTabId)?.stop()
    this.nativeKeysByTabId.delete(browserTabId)
    if (!enabled) {
      this.cancelGrabOp(browserTabId, 'user')
      retireGrabOverlay(scope)
      return (
        (await runOverlayScript(guest, 'teardown', signal, scope)) === true &&
        scope.current &&
        canDeliver?.() !== false &&
        !signal?.aborted
      )
    }
    // Arm eagerly so hover feedback appears before selection starts.
    const armed = await runOverlayScript(guest, 'arm', signal, scope)
    if (signal?.aborted || canDeliver?.() === false || !scope.current) {
      if (armed) {
        retireGrabOverlay(scope)
      }
      return false
    }
    // Advisory: a busy lane delays the footprint but never turns a completed arm into a failure.
    if (armed && this.grabLabelAvoidAreaByTabId.has(browserTabId)) {
      void this.syncLabelAvoidArea(browserTabId, guest, scope)
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
          canDeliver,
          onUnavailable,
          paletteKeys
        )
        this.nativeKeysByTabId.set(browserTabId, keys)
        if (
          !(await recoverBrowserInputGuard(guest)) ||
          !(await keys.setEnabled(!isAgentInjectingKeyboard(guest)))
        ) {
          // Don't leave the picker drawn with no key session if the renderer's follow-up cancel never lands.
          retireGrabOverlay(scope)
          keys.stop()
          if (this.nativeKeysByTabId.get(browserTabId) === keys) {
            this.nativeKeysByTabId.delete(browserTabId)
          }
          return false
        }
      }
    }
    return armed === true && scope.current && canDeliver?.() !== false && !signal?.aborted
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
    selectionId: string | undefined,
    guest: Electron.WebContents
  ): Promise<BrowserGrabScreenshot | null> {
    return captureGrabSelectionScreenshot(rect, guest, selectionId, () =>
      this.holdPaintForCapture(guest.id)
    )
  }

  captureCleanPage(
    guest: Electron.WebContents,
    signal: AbortSignal
  ): Promise<BrowserCleanPageCapture | null> {
    // A readback waiting for the lane must not submit after the page moved on to another document.
    const scope = grabDocumentScope(guest)
    const sameDocument = (): boolean => scope.current && grabDocumentScope(guest) === scope
    const hold = (): (() => void) => this.holdPaintForCapture(guest.id)
    return captureCleanDocumentPage(guest, signal, hold, sameDocument)
  }

  /** Preserve the active selection overlay and awaitClick listener. */
  async extractHoverPayload(
    _browserTabId: string,
    guest: Electron.WebContents
  ): Promise<BrowserGrabPayload | null> {
    try {
      const execution = await requestGrabExecution(guest, '', {
        capturePick: 'hover',
        overlayAction: { action: 'extractHover' }
      })
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

import {
  grabModeOperationByPageId,
  retireGrabModeAdmission,
  queueGrabModeOperation,
  supersededGrabMode
} from './browser-grab-mode-admission'
import { ipcMain } from 'electron'
import {
  grabDocumentScope,
  retireGrabOverlay,
  type GrabDocumentScope
} from '../../browser/element-grab/grab-guest-execution'
import { browserManager } from '../../browser/guest-lifecycle/manager/browser-manager'
import { onDocPreviewGrantRevoked } from '../../browser/document-preview/doc-preview-grant-registry'
import { isTrustedBrowserRenderer } from './browser-renderer-trust'
import { waitForNextTabRegistration } from './browser-tab-registration-wait'
import type {
  BrowserSetGrabModeArgs,
  BrowserSetGrabModeResult,
  BrowserAwaitGrabSelectionArgs,
  BrowserGrabResult,
  BrowserCancelGrabArgs,
  BrowserSetGrabLabelAvoidAreaArgs,
  BrowserGrabPickedElementPresentArgs,
  BrowserCaptureSelectionScreenshotArgs,
  BrowserCaptureSelectionScreenshotResult,
  BrowserExtractHoverArgs,
  BrowserExtractHoverResult
} from '../../../shared/browser/element-grab/browser-grab-types'
import {
  GRAB_BUDGET,
  parseGrabLabelAvoidArea
} from '../../../shared/browser/element-grab/browser-grab-types'

const grabModeOwnerByPageId = new Map<
  string,
  { requestId?: string; senderId: number; scope?: GrabDocumentScope }
>()
const GRAB_REGISTRATION_WAIT_MS = 1_000
const grabModeIntentByPageId = new Map<string, { generation: number; enabled: boolean }>()
export function resetGrabModeState(): void {
  disposePreviewGrantSubscription?.()
  disposePreviewGrantSubscription = null
  grabModeIntentByPageId.clear()
  grabModeOwnerByPageId.clear()
  for (const state of grabModeOperationByPageId.values()) {
    retireGrabModeAdmission(state)
  }
  grabModeOperationByPageId.clear()
}

export function disposeGrabModeStateForPage(browserPageId: string): void {
  grabModeIntentByPageId.delete(browserPageId)
  grabModeOwnerByPageId.delete(browserPageId)
  const state = grabModeOperationByPageId.get(browserPageId)
  if (state) {
    retireGrabModeAdmission(state)
  }
  grabModeOperationByPageId.delete(browserPageId)
}

let disposePreviewGrantSubscription: (() => void) | null = null

function subscribeToPreviewGrantRevocation(): void {
  disposePreviewGrantSubscription?.()
  disposePreviewGrantSubscription = onDocPreviewGrantRevoked((grant) => {
    browserManager.cancelGrabOp(grant.browserPageId, 'evicted')
    disposeGrabModeStateForPage(grant.browserPageId)
  })
}

export function registerBrowserGrabHandlers(): void {
  subscribeToPreviewGrantRevocation()
  ipcMain.removeHandler('browser:setGrabMode')
  ipcMain.removeHandler('browser:awaitGrabSelection')
  ipcMain.removeHandler('browser:cancelGrab')
  ipcMain.removeHandler('browser:setGrabLabelAvoidArea')
  ipcMain.removeHandler('browser:grabPickedElementPresent')
  ipcMain.removeHandler('browser:captureSelectionScreenshot')
  ipcMain.removeHandler('browser:extractHoverPayload')

  ipcMain.handle(
    'browser:setGrabMode',
    async (event, args: BrowserSetGrabModeArgs): Promise<BrowserSetGrabModeResult> => {
      if (!isTrustedBrowserRenderer(event.sender)) {
        return { ok: false, reason: 'not-authorized' }
      }
      if (
        typeof args?.browserPageId !== 'string' ||
        args.browserPageId.length > 256 ||
        typeof args.enabled !== 'boolean' ||
        (args.requestId !== undefined &&
          (typeof args.requestId !== 'string' || args.requestId.length > 200))
      ) {
        return supersededGrabMode()
      }
      const previousOwner = grabModeOwnerByPageId.get(args.browserPageId)
      if (
        previousOwner &&
        previousOwner.senderId !== event.sender.id &&
        !browserManager.getAuthorizedGuest(args.browserPageId, event.sender.id)
      ) {
        return { ok: false, reason: 'not-authorized' }
      }
      const owner = {
        requestId: args.requestId,
        senderId: event.sender.id,
        scope: undefined as GrabDocumentScope | undefined
      }
      grabModeOwnerByPageId.set(args.browserPageId, owner)
      const intent = {
        generation: (grabModeIntentByPageId.get(args.browserPageId)?.generation ?? 0) + 1,
        enabled: args.enabled
      }
      grabModeIntentByPageId.set(args.browserPageId, intent)
      const isCurrentIntent = (): boolean =>
        grabModeIntentByPageId.get(args.browserPageId) === intent
      return queueGrabModeOperation(args.browserPageId, async (signal) => {
        let guest = browserManager.getAuthorizedGuest(args.browserPageId, event.sender.id)
        if (!guest && args.enabled) {
          await waitForNextTabRegistration(
            args.browserPageId,
            GRAB_REGISTRATION_WAIT_MS,
            signal
          ).catch(() => {})
          guest = browserManager.getAuthorizedGuest(args.browserPageId, event.sender.id)
        }
        if (!isCurrentIntent() || signal.aborted) {
          return supersededGrabMode()
        }
        if (!guest) {
          return args.enabled ? supersededGrabMode() : { ok: true, clean: false }
        }
        owner.scope = grabDocumentScope(guest)
        const success = await browserManager.setGrabMode(
          args.browserPageId,
          args.enabled,
          guest,
          event.sender,
          () => browserManager.getAuthorizedGuest(args.browserPageId, event.sender.id) === guest,
          signal,
          () => {
            if (
              grabModeOwnerByPageId.get(args.browserPageId) === owner &&
              !event.sender.isDestroyed()
            ) {
              event.sender.send('browser:grabPolicyRetired', {
                browserPageId: args.browserPageId,
                requestId: args.requestId
              })
            }
          }
        )
        if (!isCurrentIntent() || signal.aborted) {
          return supersededGrabMode()
        }
        return success
          ? { ok: true, clean: !args.enabled }
          : { ok: false, reason: 'injection-failed' }
      }).finally(() => {
        if (grabModeIntentByPageId.get(args.browserPageId) === intent) {
          grabModeIntentByPageId.delete(args.browserPageId)
        }
      })
    }
  )

  ipcMain.handle(
    'browser:awaitGrabSelection',
    async (event, args: BrowserAwaitGrabSelectionArgs): Promise<BrowserGrabResult> => {
      if (!isTrustedBrowserRenderer(event.sender)) {
        return { opId: args.opId, kind: 'error', reason: 'Not authorized' }
      }
      const guest = browserManager.getAuthorizedGuest(args.browserPageId, event.sender.id)
      if (!guest) {
        return { opId: args.opId, kind: 'error', reason: 'Guest not ready' }
      }
      const owner = grabModeOwnerByPageId.get(args.browserPageId)
      if (
        args.requestId !== undefined &&
        (!owner ||
          owner.requestId !== args.requestId ||
          owner.senderId !== event.sender.id ||
          !owner.scope?.current ||
          owner.scope !== grabDocumentScope(guest))
      ) {
        return { opId: args.opId, kind: 'cancelled', reason: 'navigation' }
      }
      return browserManager.awaitGrabSelection(args.browserPageId, args.opId, guest)
    }
  )

  ipcMain.handle(
    'browser:setGrabLabelAvoidArea',
    async (event, args: BrowserSetGrabLabelAvoidAreaArgs): Promise<boolean> => {
      if (!isTrustedBrowserRenderer(event.sender) || typeof args?.browserPageId !== 'string') {
        return false
      }
      const area = parseGrabLabelAvoidArea(args.area)
      if (area === undefined) {
        return false
      }
      return browserManager.setGrabLabelAvoidArea(args.browserPageId, area, event.sender.id)
    }
  )

  ipcMain.handle(
    'browser:grabPickedElementPresent',
    async (event, args: BrowserGrabPickedElementPresentArgs): Promise<boolean | null> => {
      if (
        !isTrustedBrowserRenderer(event.sender) ||
        typeof args?.browserPageId !== 'string' ||
        typeof args.selectionId !== 'string' ||
        args.selectionId.length === 0 ||
        args.selectionId.length > GRAB_BUDGET.selectorMaxLength
      ) {
        return false
      }
      const guest = browserManager.getAuthorizedGuest(args.browserPageId, event.sender.id)
      return guest
        ? browserManager.isGrabPickedElementPresent(
            args.selectionId,
            guest,
            args.interactive === true
          )
        : null
    }
  )

  ipcMain.handle('browser:cancelGrab', (event, args: BrowserCancelGrabArgs): boolean => {
    if (!isTrustedBrowserRenderer(event.sender)) {
      return false
    }
    const owner = grabModeOwnerByPageId.get(args.browserPageId)
    if (args.requestId !== undefined) {
      if (!owner || owner.requestId !== args.requestId || owner.senderId !== event.sender.id) {
        return false
      }
    } else if (!browserManager.getAuthorizedGuest(args.browserPageId, event.sender.id)) {
      return false
    }
    const admission = grabModeOperationByPageId.get(args.browserPageId)
    if (admission) {
      retireGrabModeAdmission(admission)
    }
    grabModeIntentByPageId.delete(args.browserPageId)
    if (owner?.scope) {
      retireGrabOverlay(owner.scope)
    }
    grabModeOwnerByPageId.delete(args.browserPageId)
    browserManager.cancelGrabOp(args.browserPageId, 'user')
    return true
  })

  ipcMain.handle(
    'browser:captureSelectionScreenshot',
    async (
      event,
      args: BrowserCaptureSelectionScreenshotArgs
    ): Promise<BrowserCaptureSelectionScreenshotResult> => {
      if (!isTrustedBrowserRenderer(event.sender)) {
        return { ok: false, reason: 'Not authorized' }
      }
      const guest = browserManager.getAuthorizedGuest(args.browserPageId, event.sender.id)
      if (!guest) {
        return { ok: false, reason: 'Guest not ready' }
      }
      const screenshot = await browserManager.captureSelectionScreenshot(
        args.browserPageId,
        args.rect,
        args.selectionId,
        guest
      )
      if (!screenshot) {
        return { ok: false, reason: 'Screenshot capture failed' }
      }
      return { ok: true, screenshot }
    }
  )

  ipcMain.handle(
    'browser:extractHoverPayload',
    async (event, args: BrowserExtractHoverArgs): Promise<BrowserExtractHoverResult> => {
      if (!isTrustedBrowserRenderer(event.sender)) {
        return { ok: false, reason: 'Not authorized' }
      }
      const guest = browserManager.getAuthorizedGuest(args.browserPageId, event.sender.id)
      if (!guest) {
        return { ok: false, reason: 'Guest not ready' }
      }
      const payload = await browserManager.extractHoverPayload(args.browserPageId, guest)
      if (!payload) {
        return { ok: false, reason: 'No element hovered' }
      }
      return { ok: true, payload }
    }
  )
}

import { ipcMain } from 'electron'
import { browserManager } from '../browser/browser-manager'
import { onDocPreviewGrantRevoked } from '../browser/doc-preview-grant-registry'
import { isTrustedBrowserRenderer } from './browser-renderer-trust'
import { waitForNextTabRegistration } from './browser-tab-registration-wait'
import type {
  BrowserSetGrabModeArgs,
  BrowserSetGrabModeResult,
  BrowserAwaitGrabSelectionArgs,
  BrowserGrabResult,
  BrowserCancelGrabArgs,
  BrowserCaptureSelectionScreenshotArgs,
  BrowserCaptureSelectionScreenshotResult,
  BrowserExtractHoverArgs,
  BrowserExtractHoverResult
} from '../../shared/browser-grab-types'

const grabModeIntentByPageId = new Map<string, { generation: number; enabled: boolean }>()
const grabModeOperationByPageId = new Map<string, Promise<void>>()
const GRAB_REGISTRATION_WAIT_MS = 1_000

function queueGrabModeOperation(
  browserPageId: string,
  operation: () => Promise<BrowserSetGrabModeResult>
): Promise<BrowserSetGrabModeResult> {
  const previous = grabModeOperationByPageId.get(browserPageId) ?? Promise.resolve()
  const result = previous.then(operation)
  const completion = result.then(
    () => {},
    () => {}
  )
  grabModeOperationByPageId.set(browserPageId, completion)
  return result.finally(() => {
    if (grabModeOperationByPageId.get(browserPageId) === completion) {
      grabModeOperationByPageId.delete(browserPageId)
    }
  })
}

export function resetGrabModeState(): void {
  grabModeIntentByPageId.clear()
  // Why: a stale in-flight chain from a prior registration would block new operations forever.
  grabModeOperationByPageId.clear()
}

export function disposeGrabModeStateForPage(browserPageId: string): void {
  grabModeIntentByPageId.delete(browserPageId)
  // Why: don't let a reused browserPageId queue behind the destroyed guest's pending chain.
  grabModeOperationByPageId.delete(browserPageId)
}

/**
 * Why previews need their own disposal path: a browser page announces its own death on
 * `browser:unregisterGuest`, and a preview never does — it withdraws by revoking its grant, which
 * is also what a re-mint does. Without this, every grant leaves an intent entry behind forever.
 */
let disposePreviewGrantSubscription: (() => void) | null = null

function subscribeToPreviewGrantRevocation(): void {
  disposePreviewGrantSubscription?.()
  disposePreviewGrantSubscription = onDocPreviewGrantRevoked((grant) => {
    // Why cancel first: a grab still armed on that guest would otherwise leave the renderer's
    // await hanging on a surface the reader has already closed.
    browserManager.cancelGrabOp(grant.browserPageId, 'evicted')
    disposeGrabModeStateForPage(grant.browserPageId)
  })
}

export function registerBrowserGrabHandlers(): void {
  subscribeToPreviewGrantRevocation()
  ipcMain.removeHandler('browser:setGrabMode')
  ipcMain.removeHandler('browser:awaitGrabSelection')
  ipcMain.removeHandler('browser:cancelGrab')
  ipcMain.removeHandler('browser:captureSelectionScreenshot')
  ipcMain.removeHandler('browser:extractHoverPayload')

  ipcMain.handle(
    'browser:setGrabMode',
    async (event, args: BrowserSetGrabModeArgs): Promise<BrowserSetGrabModeResult> => {
      if (!isTrustedBrowserRenderer(event.sender)) {
        return { ok: false, reason: 'not-authorized' }
      }
      const intent = {
        generation: (grabModeIntentByPageId.get(args.browserPageId)?.generation ?? 0) + 1,
        enabled: args.enabled
      }
      grabModeIntentByPageId.set(args.browserPageId, intent)
      const isCurrentIntent = (): boolean =>
        grabModeIntentByPageId.get(args.browserPageId) === intent
      let guest = browserManager.getAuthorizedGuest(args.browserPageId, event.sender.id)
      if (!guest && args.enabled) {
        // Why: fast file:// pages can expose the toolbar before did-attach registration reaches main.
        await waitForNextTabRegistration(args.browserPageId, GRAB_REGISTRATION_WAIT_MS).catch(
          () => {}
        )
        if (!isCurrentIntent()) {
          return { ok: true }
        }
        guest = browserManager.getAuthorizedGuest(args.browserPageId, event.sender.id)
      }
      if (!guest) {
        if (!args.enabled) {
          return { ok: true }
        }
        return { ok: false, reason: 'not-ready' }
      }
      return queueGrabModeOperation(args.browserPageId, async () => {
        if (!isCurrentIntent()) {
          return { ok: true }
        }
        guest = browserManager.getAuthorizedGuest(args.browserPageId, event.sender.id)
        if (!guest) {
          return args.enabled ? { ok: false, reason: 'not-ready' } : { ok: true }
        }
        const success = await browserManager.setGrabMode(args.browserPageId, args.enabled, guest)
        if (!isCurrentIntent()) {
          return { ok: true }
        }
        return success ? { ok: true } : { ok: false, reason: 'injection-failed' }
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
      // Why: no hasActiveGrabOp guard here — awaitGrabSelection already handles
      // the conflict by cancelling the previous op. Blocking at the IPC layer
      // would create a race window where rearm() fails if the previous IPC call
      // hasn't fully resolved yet.
      return browserManager.awaitGrabSelection(args.browserPageId, args.opId, guest)
    }
  )

  ipcMain.handle('browser:cancelGrab', (event, args: BrowserCancelGrabArgs): boolean => {
    if (!isTrustedBrowserRenderer(event.sender)) {
      return false
    }
    // Why: verify the sender actually owns this tab, consistent with the
    // authorization check in setGrabMode/awaitGrabSelection/captureScreenshot.
    const guest = browserManager.getAuthorizedGuest(args.browserPageId, event.sender.id)
    if (!guest) {
      return false
    }
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

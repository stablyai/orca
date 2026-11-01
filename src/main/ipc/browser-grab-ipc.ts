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
  // Retired registrations must not leave chains blocking new operations.
  grabModeOperationByPageId.clear()
}

export function disposeGrabModeStateForPage(browserPageId: string): void {
  grabModeIntentByPageId.delete(browserPageId)
  // Reused page IDs must not queue behind destroyed guests.
  grabModeOperationByPageId.delete(browserPageId)
}

// Previews withdraw through grant revocation, not unregisterGuest; dispose their retained intent then.
let disposePreviewGrantSubscription: (() => void) | null = null

function subscribeToPreviewGrantRevocation(): void {
  disposePreviewGrantSubscription?.()
  disposePreviewGrantSubscription = onDocPreviewGrantRevoked((grant) => {
    // Settle pending grabs before disposing the guest's intent.
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
        // Fast file pages can expose tools before guest registration reaches main.
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
      // awaitGrabSelection cancels previous grabs; an extra active-op guard would race rearming.
      return browserManager.awaitGrabSelection(args.browserPageId, args.opId, guest)
    }
  )

  ipcMain.handle('browser:cancelGrab', (event, args: BrowserCancelGrabArgs): boolean => {
    if (!isTrustedBrowserRenderer(event.sender)) {
      return false
    }
    // Resolve through sender ownership, as the other grab channels do.
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

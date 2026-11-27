import { ipcMain } from 'electron'
import { browserManager } from '../../browser/guest-lifecycle/manager/browser-manager'
import { onDocPreviewGrantRevoked } from '../../browser/document-preview/doc-preview-grant-registry'
import { isTrustedBrowserRenderer } from './browser-renderer-trust'
import { waitForNextTabRegistration } from './browser-tab-registration-wait'
import {
  captureCleanBrowserPage,
  disposeGrabModeStateForPage,
  setBrowserGrabMode
} from '../../browser/element-grab/browser-grab-mode-sequencer'
import { isBrowserCaptureCleanPageArgs } from '../../../shared/browser/element-grab/browser-grab-types'
import type {
  BrowserSetGrabModeArgs,
  BrowserSetGrabModeResult,
  BrowserAwaitGrabSelectionArgs,
  BrowserGrabResult,
  BrowserCancelGrabArgs,
  BrowserCaptureSelectionScreenshotArgs,
  BrowserCaptureSelectionScreenshotResult,
  BrowserExtractHoverArgs,
  BrowserExtractHoverResult,
  BrowserCleanPageCapture
} from '../../../shared/browser/element-grab/browser-grab-types'

const GRAB_REGISTRATION_WAIT_MS = 1_000
const cleanCapturesByAttemptId = new Map<string, { senderId: number; retire: () => void }>()

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
  ipcMain.removeHandler('browser:captureCleanPage')
  ipcMain.removeHandler('browser:retireCleanCapture')

  ipcMain.handle(
    'browser:setGrabMode',
    async (event, args: BrowserSetGrabModeArgs): Promise<BrowserSetGrabModeResult> => {
      if (!isTrustedBrowserRenderer(event.sender)) {
        return { ok: false, reason: 'not-authorized' }
      }
      return setBrowserGrabMode(
        args.browserPageId,
        args.enabled,
        () => browserManager.getAuthorizedGuest(args.browserPageId, event.sender.id),
        // Fast file pages can expose tools before guest registration reaches main.
        () =>
          waitForNextTabRegistration(args.browserPageId, GRAB_REGISTRATION_WAIT_MS).catch(() => {})
      )
    }
  )

  ipcMain.handle(
    'browser:captureCleanPage',
    async (event, args: unknown): Promise<BrowserCleanPageCapture | null> => {
      // Validated and authorized before anything shared changes, so a denied caller can't retire a live arm.
      if (
        !isTrustedBrowserRenderer(event.sender) ||
        !isBrowserCaptureCleanPageArgs(args) ||
        cleanCapturesByAttemptId.has(args.attemptId)
      ) {
        return null
      }
      const resolveGuest = (): Electron.WebContents | null =>
        browserManager.getAuthorizedGuest(args.browserPageId, event.sender.id)
      const guest = resolveGuest()
      // Only the guest and settled document the request began on: a replaced guest or a load already under way
      // (even to the same URL) would hand Draw a page the user never asked to draw on.
      if (!guest || guest.id !== args.guestId || guest.isLoadingMainFrame()) {
        return null
      }
      const { capture, retire } = captureCleanBrowserPage(
        args.browserPageId,
        guest,
        resolveGuest,
        args.deadlineMs
      )
      cleanCapturesByAttemptId.set(args.attemptId, { senderId: event.sender.id, retire })
      try {
        return await capture
      } finally {
        cleanCapturesByAttemptId.delete(args.attemptId)
      }
    }
  )

  ipcMain.handle('browser:retireCleanCapture', (event, args: unknown): void => {
    const attemptId =
      typeof args === 'object' && args !== null && 'attemptId' in args ? args.attemptId : null
    const attempt = typeof attemptId === 'string' ? cleanCapturesByAttemptId.get(attemptId) : null
    if (attempt?.senderId === event.sender.id) {
      attempt.retire()
    }
  })

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

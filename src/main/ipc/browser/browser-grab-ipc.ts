import { supersededGrabMode } from './browser-grab-mode-admission'
import {
  setBrowserGrabMode,
  cancelBrowserGrabMode,
  isCurrentBrowserGrabRequest,
  disposeGrabModeStateForPage,
  resetGrabModeState as resetSharedGrabModeState
} from '../../browser/element-grab/browser-grab-mode-sequencer'
import { ipcMain } from 'electron'
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

const GRAB_REGISTRATION_WAIT_MS = 1_000
export { disposeGrabModeStateForPage }
export function resetGrabModeState(): void {
  disposePreviewGrantSubscription?.()
  disposePreviewGrantSubscription = null
  resetSharedGrabModeState()
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
        (args.paletteKeys !== undefined && typeof args.paletteKeys !== 'boolean') ||
        (args.requestId !== undefined &&
          (typeof args.requestId !== 'string' || args.requestId.length > 200))
      ) {
        return supersededGrabMode()
      }
      return setBrowserGrabMode(
        args.browserPageId,
        args.enabled,
        () => browserManager.getAuthorizedGuest(args.browserPageId, event.sender.id),
        (signal) =>
          waitForNextTabRegistration(args.browserPageId, GRAB_REGISTRATION_WAIT_MS, signal),
        {
          requestId: args.requestId,
          paletteKeys: args.paletteKeys,
          owner: `renderer:${event.sender.id}`,
          destination: event.sender,
          onPolicyRetired: () => {
            if (!event.sender.isDestroyed()) {
              event.sender.send('browser:grabPolicyRetired', {
                browserPageId: args.browserPageId,
                requestId: args.requestId
              })
            }
          }
        }
      )
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
      if (
        !isCurrentBrowserGrabRequest(
          args.browserPageId,
          guest,
          args.requestId,
          `renderer:${event.sender.id}`
        )
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
    return cancelBrowserGrabMode(
      args.browserPageId,
      () => browserManager.getAuthorizedGuest(args.browserPageId, event.sender.id),
      args.requestId,
      `renderer:${event.sender.id}`
    )
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

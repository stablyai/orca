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

const grabModeIntentByPageId = new Map<string, { generation: number; enabled: boolean }>()
type GrabModeRequest = {
  run: (signal: AbortSignal) => Promise<BrowserSetGrabModeResult>
  resolve: (result: BrowserSetGrabModeResult) => void
}
type GrabModeAdmission = { active: AbortController | null; pending: GrabModeRequest | null }
const grabModeOperationByPageId = new Map<string, GrabModeAdmission>()
const GRAB_REGISTRATION_WAIT_MS = 1_000
const MAX_GRAB_MODE_ADMISSIONS = 32
const supersededGrabMode = (): BrowserSetGrabModeResult => ({ ok: false, reason: 'not-ready' })

function retireGrabModeAdmission(state: GrabModeAdmission): void {
  state.active?.abort()
  state.pending?.resolve(supersededGrabMode())
  state.pending = null
}

function queueGrabModeOperation(
  browserPageId: string,
  operation: GrabModeRequest['run']
): Promise<BrowserSetGrabModeResult> {
  let state = grabModeOperationByPageId.get(browserPageId)
  const created = !state
  if (!state) {
    if (grabModeOperationByPageId.size >= MAX_GRAB_MODE_ADMISSIONS) {
      return Promise.resolve(supersededGrabMode())
    }
    state = { active: null, pending: null }
    grabModeOperationByPageId.set(browserPageId, state)
  }
  retireGrabModeAdmission(state)
  const admission = state
  const result = new Promise<BrowserSetGrabModeResult>((resolve) => {
    admission.pending = { run: operation, resolve }
  })
  if (created) {
    void (async () => {
      while (admission.pending) {
        const request = admission.pending
        admission.pending = null
        const abort = new AbortController()
        admission.active = abort
        try {
          request.resolve(await request.run(abort.signal))
        } catch {
          request.resolve({ ok: false, reason: 'injection-failed' })
        } finally {
          admission.active = null
        }
      }
      if (grabModeOperationByPageId.get(browserPageId) === admission) {
        grabModeOperationByPageId.delete(browserPageId)
      }
    })()
  }
  return result
}

export function resetGrabModeState(): void {
  disposePreviewGrantSubscription?.()
  disposePreviewGrantSubscription = null
  grabModeIntentByPageId.clear()
  for (const state of grabModeOperationByPageId.values()) {
    retireGrabModeAdmission(state)
  }
  grabModeOperationByPageId.clear()
}

export function disposeGrabModeStateForPage(browserPageId: string): void {
  grabModeIntentByPageId.delete(browserPageId)
  const state = grabModeOperationByPageId.get(browserPageId)
  if (state) {
    retireGrabModeAdmission(state)
  }
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
        typeof args.enabled !== 'boolean'
      ) {
        return supersededGrabMode()
      }
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
          return args.enabled ? supersededGrabMode() : { ok: true }
        }
        const success = await browserManager.setGrabMode(
          args.browserPageId,
          args.enabled,
          guest,
          event.sender,
          () => browserManager.getAuthorizedGuest(args.browserPageId, event.sender.id) === guest,
          signal
        )
        if (!isCurrentIntent() || signal.aborted) {
          return supersededGrabMode()
        }
        return success ? { ok: true } : { ok: false, reason: 'injection-failed' }
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
      // awaitGrabSelection cancels previous grabs; an extra active-op guard would race rearming.
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
      // Unavailable identity cannot authorize a held-pick action.
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

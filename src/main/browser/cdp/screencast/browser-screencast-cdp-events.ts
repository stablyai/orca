import { Buffer } from 'node:buffer'
import type { BrowserScreencastFrameMetadata } from '../../../../shared/browser/screencast/browser-screencast-protocol'
import { enrichFrameMetadata, readFrameMetadata } from './browser-screencast-frame-metadata'
import { readBrowserScreencastImageSize } from './browser-screencast-image-size'
import type {
  BrowserScreencastEvent,
  BrowserScreencastOptions,
  PendingScreencastFrame
} from './browser-screencast-stream-types'
import { isLiveFrameCompatibleWithViewport } from './browser-screencast-viewport-fit'
import type { BrowserJavaScriptDialogPrompt } from '../../../../shared/browser/prompts/browser-javascript-dialog'

export function browserScreencastDialogEvent(
  dialog: BrowserJavaScriptDialogPrompt
): BrowserScreencastEvent {
  return {
    type: 'dialog',
    dialogType: dialog.type,
    message: dialog.message,
    defaultPromptText: dialog.defaultPromptText,
    origin: dialog.origin
  }
}

type BrowserScreencastPageEventHandlerDeps = {
  options: Pick<BrowserScreencastOptions, 'onEvent'>
  isClosed: () => boolean
  isStopping: () => boolean
  /** Every lane's: static pages may finish navigation without emitting a live frame. */
  scheduleNavigationFrameCapture: () => void
  /** The page's dialog Orca still holds; a CDP close can be a second frame's turned-away one. */
  openDialog: () => BrowserJavaScriptDialogPrompt | null
}

/** Page events on the stream's own CDP session; frames go to the lane that asked for them. */
export function createBrowserScreencastPageEventHandler(
  deps: BrowserScreencastPageEventHandlerDeps
): (method: string, params: unknown) => void {
  const { options, isClosed, isStopping, scheduleNavigationFrameCapture, openDialog } = deps

  return (method: string, params: unknown): void => {
    if (isClosed() || isStopping()) {
      return
    }
    // Openings come from Orca's dialog owner (see startBrowserScreencast), which knows the asking frame.
    if (method === 'Page.javascriptDialogClosed') {
      const open = openDialog()
      options.onEvent?.(open ? browserScreencastDialogEvent(open) : { type: 'dialogClosed' })
      return
    }
    if (method === 'Page.frameNavigated') {
      const payload =
        params && typeof params === 'object' ? (params as Record<string, unknown>) : {}
      const frame = payload.frame && typeof payload.frame === 'object' ? payload.frame : null
      if (!frame || !('parentId' in frame)) {
        scheduleNavigationFrameCapture()
      }
      return
    }
    if (method === 'Page.loadEventFired') {
      scheduleNavigationFrameCapture()
    }
  }
}

type BrowserScreencastFrameHandlerDeps = {
  options: BrowserScreencastOptions
  isClosed: () => boolean
  isStopping: () => boolean
  queueFrame: (frame: PendingScreencastFrame) => void
  ackScreencastFrame: (sessionId: number | undefined) => void
  scheduleNavigationFrameCapture: (reason?: 'navigation' | 'viewport-recovery') => void
  clearNavigationCaptureTimer: () => void
  bumpSnapshotGeneration: () => void
  /** True while guest frames must be dropped pending re-emulation. */
  observeGuestViewSize: (metadata: BrowserScreencastFrameMetadata) => boolean
}

export function createBrowserScreencastFrameHandler(
  deps: BrowserScreencastFrameHandlerDeps
): (params: unknown) => void {
  const { options, isClosed, isStopping, queueFrame, ackScreencastFrame } = deps
  const { scheduleNavigationFrameCapture, clearNavigationCaptureTimer, bumpSnapshotGeneration } =
    deps
  const { observeGuestViewSize } = deps

  return (params: unknown): void => {
    if (isClosed()) {
      return
    }
    const payload = params && typeof params === 'object' ? (params as Record<string, unknown>) : {}
    const data = typeof payload.data === 'string' ? payload.data : null
    const sessionId =
      typeof payload.sessionId === 'number' && Number.isFinite(payload.sessionId)
        ? payload.sessionId
        : null
    if (sessionId === null) {
      return
    }
    if (!data || isStopping()) {
      ackScreencastFrame(sessionId)
      return
    }

    try {
      const metadata = readFrameMetadata(payload.metadata)
      if (observeGuestViewSize(metadata)) {
        ackScreencastFrame(sessionId)
        return
      }
      const decoded = Buffer.from(data, 'base64')
      const image =
        decoded.buffer.byteLength === decoded.byteLength ? decoded : new Uint8Array(decoded)
      const imageSize = readBrowserScreencastImageSize(image, options.format)
      if (!isLiveFrameCompatibleWithViewport(imageSize, options)) {
        // Tab switches and navigation can briefly stream the host surface instead of the client viewport.
        ackScreencastFrame(sessionId)
        scheduleNavigationFrameCapture('viewport-recovery')
        return
      }
      bumpSnapshotGeneration()
      clearNavigationCaptureTimer()
      queueFrame({
        metadata: enrichFrameMetadata(metadata, imageSize, options),
        image,
        sessionId
      })
    } catch {
      ackScreencastFrame(sessionId)
    }
  }
}

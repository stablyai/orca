import { Buffer } from 'node:buffer'
import type { WebContents } from 'electron'
import type { BrowserScreencastFrameMetadata } from '../../shared/browser-screencast-protocol'
import { sendDebuggerCommand } from './browser-screencast-debugger-command'
import { enrichFrameMetadata, readFrameMetadata } from './browser-screencast-frame-metadata'
import { readBrowserScreencastImageSize } from './browser-screencast-image-size'
import type {
  BrowserScreencastOptions,
  PendingScreencastFrame
} from './browser-screencast-stream-types'
import { isLiveFrameCompatibleWithViewport } from './browser-screencast-viewport-fit'
import type { BrowserJavaScriptDialog } from '../../shared/browser-javascript-dialog'

type BrowserScreencastMessageHandlerDeps = {
  dbg: WebContents['debugger']
  options: BrowserScreencastOptions
  isClosed: () => boolean
  isStopping: () => boolean
  queueFrame: (frame: PendingScreencastFrame) => void
  ackScreencastFrame: (sessionId: number | undefined) => void
  scheduleNavigationFrameCapture: () => void
  clearNavigationCaptureTimer: () => void
  bumpSnapshotGeneration: () => void
  /** True while guest frames must be dropped pending re-emulation. */
  observeGuestViewSize: (metadata: BrowserScreencastFrameMetadata) => boolean
  /** The page's dialog Orca still holds; a CDP close can be a second frame's turned-away one. */
  openDialog: () => BrowserJavaScriptDialog | null
}

export function createBrowserScreencastMessageHandler(
  deps: BrowserScreencastMessageHandlerDeps
): (event: unknown, method: string, params: unknown) => void {
  const { dbg, options, isClosed, isStopping, queueFrame, ackScreencastFrame } = deps
  const { scheduleNavigationFrameCapture, clearNavigationCaptureTimer, bumpSnapshotGeneration } =
    deps
  const { observeGuestViewSize, openDialog } = deps

  return (_event: unknown, method: string, params: unknown): void => {
    if (isClosed()) {
      return
    }
    if (isStopping() && method !== 'Page.screencastFrame') {
      return
    }
    if (method === 'Page.javascriptDialogOpening') {
      const payload =
        params && typeof params === 'object' ? (params as Record<string, unknown>) : {}
      options.onEvent?.({
        type: 'dialog',
        dialogType: typeof payload.type === 'string' ? payload.type : 'alert',
        message: typeof payload.message === 'string' ? payload.message : 'Browser dialog'
      })
      return
    }
    if (method === 'Page.javascriptDialogClosed') {
      const open = openDialog()
      options.onEvent?.(
        open
          ? { type: 'dialog', dialogType: open.type, message: open.message }
          : { type: 'dialogClosed' }
      )
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
      return
    }
    if (method !== 'Page.screencastFrame') {
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
    if (!data) {
      ackScreencastFrame(sessionId)
      return
    }
    if (isStopping()) {
      void sendDebuggerCommand(dbg, 'Page.screencastFrameAck', { sessionId }).catch(() => {})
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
        scheduleNavigationFrameCapture()
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

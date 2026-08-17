import { Buffer } from 'node:buffer'
import type { WebContents } from 'electron'
import { sendDebuggerCommand } from './browser-screencast-debugger-command'
import { enrichFrameMetadata, readFrameMetadata } from './browser-screencast-frame-metadata'
import { readBrowserScreencastImageSize } from './browser-screencast-image-size'
import type {
  BrowserScreencastOptions,
  PendingScreencastFrame
} from './browser-screencast-stream-types'
import { isLiveFrameCompatibleWithViewport } from './browser-screencast-viewport-fit'

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
}

export function createBrowserScreencastMessageHandler(
  deps: BrowserScreencastMessageHandlerDeps
): (event: unknown, method: string, params: unknown) => void {
  const { dbg, options, isClosed, isStopping, queueFrame, ackScreencastFrame } = deps
  const { scheduleNavigationFrameCapture, clearNavigationCaptureTimer, bumpSnapshotGeneration } =
    deps

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
      options.onEvent?.({ type: 'dialogClosed' })
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
    const sessionId = typeof payload.sessionId === 'number' ? payload.sessionId : null
    if (!data || sessionId === null) {
      return
    }
    if (isStopping()) {
      void sendDebuggerCommand(dbg, 'Page.screencastFrameAck', { sessionId }).catch(() => {})
      return
    }

    try {
      const image = new Uint8Array(Buffer.from(data, 'base64'))
      // Why: image dimension parsing happens for every live frame; share the
      // result between stale-frame rejection and metadata enrichment.
      const imageSize = readBrowserScreencastImageSize(image, options.format)
      if (!isLiveFrameCompatibleWithViewport(imageSize, options)) {
        // Why: after tab switches/navigation Chromium can briefly stream the
        // host surface instead of the requested client viewport. Dropping that
        // frame keeps the client from rendering server-sized blank gutters.
        ackScreencastFrame(sessionId)
        scheduleNavigationFrameCapture()
        return
      }
      bumpSnapshotGeneration()
      clearNavigationCaptureTimer()
      queueFrame({
        metadata: enrichFrameMetadata(readFrameMetadata(payload.metadata), imageSize, options),
        image,
        sessionId
      })
    } catch {
      ackScreencastFrame(sessionId)
    }
  }
}

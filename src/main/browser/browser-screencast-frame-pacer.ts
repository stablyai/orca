import type { WebContents } from 'electron'
import {
  BrowserScreencastOpcode,
  encodeBrowserScreencastFrame
} from '../../shared/browser-screencast-protocol'
import { sendDebuggerCommand } from './browser-screencast-debugger-command'
import type {
  BrowserScreencastOptions,
  PendingScreencastFrame
} from './browser-screencast-stream-types'

const BACKPRESSURE_RETRY_MS = 50

type BrowserScreencastFramePacerDeps = {
  dbg: WebContents['debugger']
  options: BrowserScreencastOptions
  isClosed: () => boolean
  isStopping: () => boolean
}

export type BrowserScreencastFramePacer = {
  queueFrame: (frame: PendingScreencastFrame) => void
  ackFrame: (sessionId: number | undefined) => void
  clearPending: (ackPending?: boolean) => void
  getSeq: () => number
}

export function createBrowserScreencastFramePacer(
  deps: BrowserScreencastFramePacerDeps
): BrowserScreencastFramePacer {
  const { dbg, options, isClosed, isStopping } = deps
  let seq = 0
  let lastFrameSentAt = 0
  let pendingFrame: PendingScreencastFrame | null = null
  let pendingFrameTimer: ReturnType<typeof setTimeout> | null = null

  const ackScreencastFrame = (sessionId: number | undefined): void => {
    if (sessionId === undefined) {
      return
    }
    // Why: CDP only sends the next frame after ACK; delaying ACK for
    // throttled frames applies back-pressure before Chromium/base64 work piles up.
    void sendDebuggerCommand(dbg, 'Page.screencastFrameAck', { sessionId }).catch(() => {})
  }

  const clearPendingFrameTimer = (ackPending = false): void => {
    const pending = pendingFrame
    pendingFrame = null
    if (pendingFrameTimer) {
      clearTimeout(pendingFrameTimer)
      pendingFrameTimer = null
    }
    if (ackPending) {
      ackScreencastFrame(pending?.sessionId)
    }
  }

  const emitFrame = (frame: PendingScreencastFrame): boolean => {
    if (isClosed() || isStopping()) {
      return false
    }
    lastFrameSentAt = Date.now()
    const accepted = options.onFrame(
      encodeBrowserScreencastFrame({
        opcode: BrowserScreencastOpcode.Frame,
        seq: seq++,
        format: options.format,
        // Why: Chromium sometimes omits device dimensions on static/mobile
        // pages; carrying viewport/image dimensions prevents client stretch.
        metadata: frame.metadata,
        image: frame.image
      })
    )
    return accepted !== false
  }

  const schedulePendingFrameRetry = (): void => {
    if (pendingFrameTimer || isClosed() || isStopping()) {
      return
    }
    pendingFrameTimer = setTimeout(() => {
      pendingFrameTimer = null
      const latest = pendingFrame
      pendingFrame = null
      if (isClosed() || isStopping() || !latest) {
        return
      }
      if (emitFrame(latest)) {
        ackScreencastFrame(latest.sessionId)
      } else {
        pendingFrame = latest
        schedulePendingFrameRetry()
      }
    }, BACKPRESSURE_RETRY_MS)
  }

  const queueFrame = (frame: PendingScreencastFrame): void => {
    if (isClosed() || isStopping()) {
      return
    }
    const now = Date.now()
    const elapsed = now - lastFrameSentAt
    if (
      options.minFrameIntervalMs <= 0 ||
      lastFrameSentAt === 0 ||
      elapsed >= options.minFrameIntervalMs
    ) {
      clearPendingFrameTimer(true)
      if (emitFrame(frame)) {
        ackScreencastFrame(frame.sessionId)
      } else {
        pendingFrame = frame
        schedulePendingFrameRetry()
      }
      return
    }

    // Why: static UI changes can be the last frame Chromium emits. Keep the
    // newest throttled frame and flush it after the interval instead of
    // dropping it forever.
    if (pendingFrame?.sessionId !== frame.sessionId) {
      ackScreencastFrame(pendingFrame?.sessionId)
    }
    pendingFrame = frame
    if (pendingFrameTimer) {
      return
    }
    pendingFrameTimer = setTimeout(
      () => {
        pendingFrameTimer = null
        const latest = pendingFrame
        pendingFrame = null
        if (isClosed() || isStopping() || !latest) {
          return
        }
        if (emitFrame(latest)) {
          ackScreencastFrame(latest.sessionId)
        } else {
          pendingFrame = latest
          schedulePendingFrameRetry()
        }
      },
      Math.max(0, options.minFrameIntervalMs - elapsed)
    )
  }

  return {
    queueFrame,
    ackFrame: ackScreencastFrame,
    clearPending: clearPendingFrameTimer,
    getSeq: () => seq
  }
}

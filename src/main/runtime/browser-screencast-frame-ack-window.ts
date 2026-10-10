// Why: an ack from the viewer is the only measure of what has left every buffer on the way. The
// socket's bufferedAmount misses the kernel send buffer and any relay, which on a slow link hold
// seconds of frames, and terminal input queued behind them waits just as long.
export const SCREENCAST_FRAME_ACK_TIMEOUT_MS = 2_000
const MAX_WINDOW = 8

export type ScreencastFrameAckWindow = {
  /**
   * Delivers frame `seq` through `deliver` when the window has room, and counts it until acked.
   * False means the caller keeps the frame and offers it again on `onOpen`.
   */
  send(seq: number, deliver: () => boolean): boolean
  /** The viewer holds every frame up to and including `seq`. */
  ack(seq: number): void
  dispose(): void
}

export function screencastFrameAckWindowSize(requested: number | undefined): number | null {
  if (requested === undefined || !Number.isFinite(requested) || requested < 1) {
    return null
  }
  return Math.min(MAX_WINDOW, Math.floor(requested))
}

/**
 * Keeps at most `size` frames unacknowledged. A refused frame is the caller's to keep; `onOpen`
 * says when to offer it again. An ack lost on a reconnect cannot stall the stream: frames older
 * than the timeout stop counting.
 */
export function createScreencastFrameAckWindow(args: {
  size: number
  onOpen: () => void
  timeoutMs?: number
  now?: () => number
  setTimer?: (callback: () => void, ms: number) => () => void
}): ScreencastFrameAckWindow {
  const timeoutMs = args.timeoutMs ?? SCREENCAST_FRAME_ACK_TIMEOUT_MS
  const now = args.now ?? Date.now
  const setTimer =
    args.setTimer ??
    ((callback: () => void, ms: number) => {
      const timer = setTimeout(callback, ms)
      return () => clearTimeout(timer)
    })
  let inFlight: { seq: number; sentAt: number }[] = []
  let refused = false
  let cancelTimer: (() => void) | null = null

  const open = (): void => {
    cancelTimer?.()
    cancelTimer = null
    if (refused) {
      refused = false
      args.onOpen()
    }
  }
  const expire = (): void => {
    const cutoff = now() - timeoutMs
    inFlight = inFlight.filter((frame) => frame.sentAt > cutoff)
  }

  return {
    send(seq, deliver) {
      expire()
      if (inFlight.length < args.size) {
        if (!deliver()) {
          return false
        }
        inFlight.push({ seq, sentAt: now() })
        return true
      }
      refused = true
      if (!cancelTimer) {
        const oldest = inFlight[0]
        cancelTimer = setTimer(
          () => {
            cancelTimer = null
            expire()
            open()
          },
          Math.max(0, oldest.sentAt + timeoutMs - now())
        )
      }
      return false
    },
    ack(seq) {
      const before = inFlight.length
      inFlight = inFlight.filter((frame) => frame.seq > seq)
      if (inFlight.length < before) {
        open()
      }
    },
    dispose() {
      cancelTimer?.()
      cancelTimer = null
      inFlight = []
      refused = false
    }
  }
}

import { scanSynchronizedOutput } from '../../../src/shared/terminal/protocol/escape/terminal-synchronized-output-scan'

// Batch busy output because each postMessage pays bridge, WebKit IPC and paint overhead.
export const TERMINAL_WRITE_FLUSH_WINDOW_MS = 48
export const TERMINAL_INTERACTIVE_WRITE_WINDOW_MS = 16
export const TERMINAL_INTERACTIVE_WRITE_DURATION_MS = 180
export const TERMINAL_RESIZE_BURST_WINDOW_MS = 220
export const TERMINAL_RESIZE_SETTLE_MS = 56
export const TERMINAL_SYNC_FRAME_HOLD_MS = 160

// Bound UTF-16 units as backup to server ack flow control; an upstream bug must not grow this buffer forever.
export const TERMINAL_WRITE_MAX_PENDING_UNITS = 512 * 1024

// `coalesce: false` delivers at once; the document's write queue joins small writes itself.
export function createTerminalWriteCoalescer(
  deliver: (data: string) => void,
  { coalesce = true }: { coalesce?: boolean } = {}
) {
  let pendingChunks: string[] = []
  let pendingUnits = 0
  let flushTimer: ReturnType<typeof setTimeout> | null = null
  let flushDeadline = Number.POSITIVE_INFINITY
  let interactiveUntil = Number.NEGATIVE_INFINITY
  let resizeBurstUntil = Number.NEGATIVE_INFINITY
  let syncHoldDeadline = Number.POSITIVE_INFINITY
  let syncMarkerTail = ''
  let syncFrameOpen = false
  // Start expired so construction and clear deliver the first chunk without delay.
  let lastFlushAt = Number.NEGATIVE_INFINITY

  const cancelTimer = () => {
    if (flushTimer !== null) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
    flushDeadline = Number.POSITIVE_INFINITY
  }

  const flushNow = () => {
    cancelTimer()
    syncHoldDeadline = Number.POSITIVE_INFINITY
    syncFrameOpen = false
    if (pendingChunks.length === 0) {
      return
    }
    const data = pendingChunks.join('')
    pendingChunks = []
    pendingUnits = 0
    lastFlushAt = Date.now()
    deliver(data)
  }

  const flushWindow = () =>
    performance.now() < interactiveUntil
      ? TERMINAL_INTERACTIVE_WRITE_WINDOW_MS
      : TERMINAL_WRITE_FLUSH_WINDOW_MS

  const armTimerAt = (deadline: number, delayMs: number, allowExtend = false) => {
    if (!allowExtend && flushTimer !== null && deadline >= flushDeadline) {
      return
    }
    cancelTimer()
    flushDeadline = deadline
    flushTimer = setTimeout(flushNow, Math.max(0, delayMs))
  }

  const scheduleFlush = () => {
    const windowMs = flushWindow()
    const now = Date.now()
    const monoNow = performance.now()
    const remainderMs = Math.min(windowMs, Math.max(0, windowMs - (now - lastFlushAt)))
    const deadline = monoNow + remainderMs
    // Repeated gestures can shorten a pending flush, but must never postpone it.
    armTimerAt(deadline, remainderMs, false)
  }

  const beginResizeBurst = () => {
    resizeBurstUntil = performance.now() + TERMINAL_RESIZE_BURST_WINDOW_MS
  }

  const markInteractive = () => {
    interactiveUntil = performance.now() + TERMINAL_INTERACTIVE_WRITE_DURATION_MS
    resizeBurstUntil = Number.NEGATIVE_INFINITY
    if (pendingChunks.length > 0) {
      scheduleFlush()
    }
  }

  const write = (data: string) => {
    if (data === '') {
      return
    }
    const wasHoldingSyncFrame = syncFrameOpen
    const syncScan = scanSynchronizedOutput(data, syncMarkerTail, syncFrameOpen)
    syncMarkerTail = syncScan.markerTail
    syncFrameOpen = syncScan.active

    const now = Date.now()
    const monoNow = performance.now()
    const inInteractive = monoNow < interactiveUntil
    const inResizeBurst = !inInteractive && monoNow < resizeBurstUntil
    const holdOpenSyncFrame = !inInteractive && syncFrameOpen

    if (!inResizeBurst && !holdOpenSyncFrame && !wasHoldingSyncFrame) {
      if (!coalesce || (pendingChunks.length === 0 && now - lastFlushAt >= flushWindow())) {
        lastFlushAt = now
        deliver(data)
        return
      }
      pendingChunks.push(data)
      pendingUnits += data.length
      if (pendingUnits > TERMINAL_WRITE_MAX_PENDING_UNITS) {
        flushNow()
        return
      }
      if (flushTimer === null) {
        scheduleFlush()
      }
      return
    }

    pendingChunks.push(data)
    pendingUnits += data.length
    if (pendingUnits > TERMINAL_WRITE_MAX_PENDING_UNITS) {
      flushNow()
      return
    }

    if (wasHoldingSyncFrame && !syncFrameOpen && !inResizeBurst) {
      flushNow()
      return
    }

    if (inResizeBurst) {
      const cappedDeadline = Math.min(resizeBurstUntil, monoNow + TERMINAL_RESIZE_SETTLE_MS)
      const delayMs = Math.max(0, cappedDeadline - monoNow)
      armTimerAt(cappedDeadline, delayMs, true)
      return
    }

    if (syncHoldDeadline === Number.POSITIVE_INFINITY) {
      syncHoldDeadline = monoNow + TERMINAL_SYNC_FRAME_HOLD_MS
    }
    const syncDelayMs = Math.max(0, syncHoldDeadline - monoNow)
    armTimerAt(syncHoldDeadline, syncDelayMs, false)
  }

  const clear = () => {
    cancelTimer()
    pendingChunks = []
    pendingUnits = 0
    lastFlushAt = Number.NEGATIVE_INFINITY
    interactiveUntil = Number.NEGATIVE_INFINITY
    resizeBurstUntil = Number.NEGATIVE_INFINITY
    syncHoldDeadline = Number.POSITIVE_INFINITY
    syncMarkerTail = ''
    syncFrameOpen = false
  }

  const isHoldingSynchronizedOutput = () => syncFrameOpen

  return { beginResizeBurst, clear, flushNow, isHoldingSynchronizedOutput, markInteractive, write }
}

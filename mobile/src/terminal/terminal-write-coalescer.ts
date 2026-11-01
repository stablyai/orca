// Batch busy output because each postMessage pays bridge, WebKit IPC and paint overhead.
export const TERMINAL_WRITE_FLUSH_WINDOW_MS = 48
export const TERMINAL_INTERACTIVE_WRITE_WINDOW_MS = 16
export const TERMINAL_INTERACTIVE_WRITE_DURATION_MS = 180

// Bound UTF-16 units as backup to server ack flow control; an upstream bug must not grow this buffer forever.
export const TERMINAL_WRITE_MAX_PENDING_UNITS = 512 * 1024

export function createTerminalWriteCoalescer(deliver: (data: string) => void) {
  let pendingChunks: string[] = []
  let pendingUnits = 0
  let flushTimer: ReturnType<typeof setTimeout> | null = null
  let flushDeadline = Number.POSITIVE_INFINITY
  let interactiveUntil = Number.NEGATIVE_INFINITY
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

  const scheduleFlush = () => {
    const windowMs = flushWindow()
    const now = Date.now()
    const remainderMs = Math.min(windowMs, Math.max(0, windowMs - (now - lastFlushAt)))
    const deadline = now + remainderMs
    // Repeated gestures can shorten a pending flush, but must never postpone it.
    if (flushTimer !== null && deadline >= flushDeadline) {
      return
    }
    cancelTimer()
    flushDeadline = deadline
    flushTimer = setTimeout(flushNow, remainderMs)
  }

  const markInteractive = () => {
    interactiveUntil = performance.now() + TERMINAL_INTERACTIVE_WRITE_DURATION_MS
    if (pendingChunks.length > 0) {
      scheduleFlush()
    }
  }

  const write = (data: string) => {
    if (data === '') {
      return
    }
    const now = Date.now()
    if (pendingChunks.length === 0 && now - lastFlushAt >= flushWindow()) {
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
  }

  const clear = () => {
    cancelTimer()
    pendingChunks = []
    pendingUnits = 0
    lastFlushAt = Number.NEGATIVE_INFINITY
    interactiveUntil = Number.NEGATIVE_INFINITY
  }

  return { clear, flushNow, markInteractive, write }
}

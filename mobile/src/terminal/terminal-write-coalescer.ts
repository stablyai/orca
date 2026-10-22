// Why: the WebView bridge + WebKit IPC + paint cost is paid per postMessage; a busy
// PTY streams ~200 frames/s (#9302), so batching writes at ~20Hz cuts sustained CPU.
export const TERMINAL_WRITE_FLUSH_WINDOW_MS = 48
export const TERMINAL_INTERACTIVE_WRITE_WINDOW_MS = 16
export const TERMINAL_INTERACTIVE_WRITE_DURATION_MS = 180

// Why: defense-in-depth only — server ack flow control bounds inflow; this cap keeps
// an upstream flow-control bug from growing the buffer unboundedly. UTF-16 code units.
export const TERMINAL_WRITE_MAX_PENDING_UNITS = 512 * 1024

export function createTerminalWriteCoalescer(deliver: (data: string) => void) {
  let pendingChunks: string[] = []
  let pendingUnits = 0
  let flushTimer: ReturnType<typeof setTimeout> | null = null
  let flushDeadline = Number.POSITIVE_INFINITY
  let interactiveUntil = Number.NEGATIVE_INFINITY
  // Why: initialized expired so the first write after construction or clear() takes
  // the leading edge — never a silent first-chunk delay.
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
    // Scroll responses need a frame cadence; unattended output keeps its CPU-saving batch.
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
    // Leading edge: an idle terminal delivers immediately (keystroke echo adds 0ms).
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

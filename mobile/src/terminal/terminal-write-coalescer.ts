// Why: the WebView bridge + WebKit IPC + paint cost is paid per postMessage; a busy
// PTY streams ~200 frames/s (#9302), so batching writes at ~20Hz cuts sustained CPU.
export const TERMINAL_WRITE_FLUSH_WINDOW_MS = 48

// Why: defense-in-depth only — server ack flow control bounds inflow; this cap keeps
// an upstream flow-control bug from growing the buffer unboundedly. UTF-16 code units.
export const TERMINAL_WRITE_MAX_PENDING_UNITS = 512 * 1024

export function createTerminalWriteCoalescer(deliver: (data: string) => void) {
  let pendingChunks: string[] = []
  let pendingUnits = 0
  let flushTimer: ReturnType<typeof setTimeout> | null = null
  // Why: initialized expired so the first write after construction or clear() takes
  // the leading edge — never a silent first-chunk delay.
  let lastFlushAt = Number.NEGATIVE_INFINITY

  const cancelTimer = () => {
    if (flushTimer !== null) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
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

  const write = (data: string) => {
    if (data === '') {
      return
    }
    const now = Date.now()
    // Leading edge: an idle terminal delivers immediately (keystroke echo adds 0ms).
    if (pendingChunks.length === 0 && now - lastFlushAt >= TERMINAL_WRITE_FLUSH_WINDOW_MS) {
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
      // One trailing timer per window: the stream flushes at most once per 48ms.
      // Why: Date.now() is not monotonic — a backwards NTP/timezone jump would
      // otherwise arm the timer for the whole jump and stall the stream.
      const remainderMs = Math.min(
        TERMINAL_WRITE_FLUSH_WINDOW_MS,
        Math.max(0, TERMINAL_WRITE_FLUSH_WINDOW_MS - (now - lastFlushAt))
      )
      flushTimer = setTimeout(flushNow, remainderMs)
    }
  }

  const clear = () => {
    cancelTimer()
    pendingChunks = []
    pendingUnits = 0
    lastFlushAt = Number.NEGATIVE_INFINITY
  }

  return { clear, flushNow, write }
}

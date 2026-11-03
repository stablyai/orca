// Batch busy output because each postMessage pays bridge, WebKit IPC and paint overhead.
export const TERMINAL_WRITE_FLUSH_WINDOW_MS = 48
export const TERMINAL_INTERACTIVE_WRITE_WINDOW_MS = 16
export const TERMINAL_INTERACTIVE_WRITE_DURATION_MS = 180

// Bound UTF-16 units as backup to server ack flow control; an upstream bug must not grow this buffer forever.
export const TERMINAL_WRITE_MAX_PENDING_UNITS = 512 * 1024
const DEC_SYNC_BEGIN = '\x1b[?2026h'
const DEC_SYNC_END = '\x1b[?2026l'
const DEC_SYNC_HOLD_BAILOUT_MS = 1000

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
  // Start expired so construction and clear deliver the first chunk without delay.
  let lastFlushAt = Number.NEGATIVE_INFINITY
  let syncScanTail = ''
  let syncOutputActive = false
  let syncHoldStartedAt = 0

  const noteSyncSequences = (chunk: string) => {
    const combined = syncScanTail + chunk
    const lastBegin = combined.lastIndexOf(DEC_SYNC_BEGIN)
    const lastEnd = combined.lastIndexOf(DEC_SYNC_END)
    if (lastBegin > lastEnd) {
      if (!syncOutputActive) {
        syncHoldStartedAt = Date.now()
      }
      syncOutputActive = true
    } else if (lastEnd > lastBegin) {
      syncOutputActive = false
      syncHoldStartedAt = 0
    }
    syncScanTail = combined.slice(-8)
  }

  const isHoldingSynchronizedOutput = () =>
    syncOutputActive && Date.now() - syncHoldStartedAt < DEC_SYNC_HOLD_BAILOUT_MS

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
    noteSyncSequences(data)
    const now = Date.now()
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
  }

  const clear = () => {
    cancelTimer()
    pendingChunks = []
    pendingUnits = 0
    lastFlushAt = Number.NEGATIVE_INFINITY
    interactiveUntil = Number.NEGATIVE_INFINITY
    syncScanTail = ''
    syncOutputActive = false
    syncHoldStartedAt = 0
  }

  return { clear, flushNow, isHoldingSynchronizedOutput, markInteractive, write }
}

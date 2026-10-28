type SocketDeadlineClockReading = { wallMs: number; monotonicMs: number }

let outsideForegroundSince: SocketDeadlineClockReading | null = null
let completedSleepGapMs = 0
let completedOutsideForegroundMs = 0
const foregroundListeners = new Set<() => void>()

function readSocketDeadlineClock(): SocketDeadlineClockReading {
  return { wallMs: Date.now(), monotonicMs: performance.now() }
}

function sleepGapMs(start: SocketDeadlineClockReading, end: SocketDeadlineClockReading): number {
  return Math.max(0, end.wallMs - start.wallMs - (end.monotonicMs - start.monotonicMs))
}

function totalOutsideForegroundMs(now: SocketDeadlineClockReading): number {
  return (
    completedOutsideForegroundMs +
    (outsideForegroundSince ? now.monotonicMs - outsideForegroundSince.monotonicMs : 0)
  )
}

function totalSleepGapMs(now: SocketDeadlineClockReading): number {
  return (
    completedSleepGapMs + (outsideForegroundSince ? sleepGapMs(outsideForegroundSince, now) : 0)
  )
}

export function recordSocketDeadlineAppState(state: string | null | undefined): void {
  if (state === 'background' || state === 'inactive') {
    outsideForegroundSince ??= readSocketDeadlineClock()
  } else if (state === 'active' && outsideForegroundSince) {
    const now = readSocketDeadlineClock()
    completedSleepGapMs += sleepGapMs(outsideForegroundSince, now)
    completedOutsideForegroundMs += now.monotonicMs - outsideForegroundSince.monotonicMs
    outsideForegroundSince = null
    for (const listener of foregroundListeners) {
      listener()
    }
  }
}

export function startSocketDeadlineClock(): () => number {
  const armed = readSocketDeadlineClock()
  const armedSleepGapMs = totalSleepGapMs(armed)
  return () => {
    const now = readSocketDeadlineClock()
    const monotonicElapsedMs = now.monotonicMs - armed.monotonicMs
    // Only background segments can supplement native clocks that pause during device sleep.
    return monotonicElapsedMs + Math.max(0, totalSleepGapMs(now) - armedSleepGapMs)
  }
}

// Count foreground time only: RN fires a timer that came due in the background on resume, before the link could deliver.
export function startForegroundClock(): () => number {
  const armed = readSocketDeadlineClock()
  const armedOutsideMs = totalOutsideForegroundMs(armed)
  return () => {
    const now = readSocketDeadlineClock()
    return now.monotonicMs - armed.monotonicMs - (totalOutsideForegroundMs(now) - armedOutsideMs)
  }
}

// Fires on each return to the foreground; returns the unsubscribe.
export function subscribeAppForeground(listener: () => void): () => void {
  foregroundListeners.add(listener)
  return () => {
    foregroundListeners.delete(listener)
  }
}

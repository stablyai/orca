type SocketDeadlineClockReading = { wallMs: number; monotonicMs: number }

let outsideForegroundSince: SocketDeadlineClockReading | null = null
let completedSleepGapMs = 0

function readSocketDeadlineClock(): SocketDeadlineClockReading {
  return { wallMs: Date.now(), monotonicMs: performance.now() }
}

function sleepGapMs(start: SocketDeadlineClockReading, end: SocketDeadlineClockReading): number {
  return Math.max(0, end.wallMs - start.wallMs - (end.monotonicMs - start.monotonicMs))
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
    completedSleepGapMs += sleepGapMs(outsideForegroundSince, readSocketDeadlineClock())
    outsideForegroundSince = null
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

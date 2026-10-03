import { AppState } from 'react-native'

export type SocketDeadlineSample = {
  armedAtMs: number
  firedAtMs: number
  monotonicElapsedMs: number
  leftForeground: boolean
}

type DeadlineTimer = ReturnType<typeof setTimeout>

type SocketDeadlineClock = {
  finish: () => SocketDeadlineSample
}

const boundClocks = new Map<DeadlineTimer, SocketDeadlineClock>()

function defaultMonotonicNow(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now()
  }
  return Date.now()
}

function watchForegroundLoss(onLeave: () => void): () => void {
  const subscription = AppState.addEventListener('change', (state) => {
    if (state === 'background' || state === 'inactive') {
      onLeave()
    }
  })
  return () => {
    subscription.remove()
  }
}

export function startSocketDeadlineClock(
  now: () => number = Date.now,
  monotonicNow: () => number = defaultMonotonicNow,
  watchLeave: (onLeave: () => void) => () => void = watchForegroundLoss
): SocketDeadlineClock {
  const armedAtMs = now()
  const armedMonotonicMs = monotonicNow()
  let leftForeground = false
  let stopped = false
  const stopWatch = watchLeave(() => {
    leftForeground = true
  })
  return {
    finish() {
      if (!stopped) {
        stopped = true
        stopWatch()
      }
      return {
        armedAtMs,
        firedAtMs: now(),
        monotonicElapsedMs: monotonicNow() - armedMonotonicMs,
        leftForeground
      }
    }
  }
}

export function rememberSocketDeadlineClock(
  timer: DeadlineTimer,
  clock: SocketDeadlineClock
): void {
  boundClocks.set(timer, clock)
}

export function takeSocketDeadline(timer: DeadlineTimer): SocketDeadlineSample {
  const clock = boundClocks.get(timer)
  boundClocks.delete(timer)
  if (!clock) {
    const firedAtMs = Date.now()
    return {
      armedAtMs: firedAtMs,
      firedAtMs,
      monotonicElapsedMs: 0,
      leftForeground: false
    }
  }
  return clock.finish()
}

export function releaseSocketTimer(timer: DeadlineTimer | null): null {
  if (timer) {
    clearTimeout(timer)
    takeSocketDeadline(timer)
  }
  return null
}

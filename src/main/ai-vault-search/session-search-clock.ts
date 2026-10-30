export type SessionSearchTimerHandle = NodeJS.Timeout | number

export type SessionSearchClock = {
  now(): number
  setTimeout(callback: () => void, ms: number): SessionSearchTimerHandle
  clearTimeout(handle: SessionSearchTimerHandle): void
}

export const systemSessionSearchClock: SessionSearchClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => {
    const timer = setTimeout(callback, ms)
    // Reconciliation timers must not keep CLI or child processes alive.
    timer.unref?.()
    return timer
  },
  clearTimeout: (handle) => clearTimeout(handle)
}

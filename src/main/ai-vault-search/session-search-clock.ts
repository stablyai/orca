// Why injected rather than the globals: every freshness guarantee this indexer
// makes is "within one reconcile interval", and a guarantee stated in wall time
// is only a claim until a test can advance the clock and watch it hold.

/** Opaque to the indexer: the real clock hands back a timer, a fake clock an id. */
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
    // Nothing here should hold the process open: the index is a cache, and a
    // pending reconcile is never a reason to keep a CLI or a child alive.
    timer.unref?.()
    return timer
  },
  clearTimeout: (handle) => clearTimeout(handle)
}

// Why: the watcher-process supervisor's crash fuse (WatcherProcessCrashFuse)
// only resets on the app's next launch, so most retries after a genuine fuse
// trip are expected to fail forever for the rest of this session. A
// human-scale backoff keeps that cost negligible while still recovering
// promptly from a merely transient cause (a launch race, an in-flight child
// termination) that a tight, poll-interval-scale retry would matter for.
const POLLING_FALLBACK_RETRY_BASE_MS = 30_000
const POLLING_FALLBACK_RETRY_MAX_MS = 15 * 60_000

export type PollingFallbackRetry = {
  /** Arm the next backoff attempt. Call once the fallback engages, and again
   *  after each failed attempt. No-op while an attempt is already pending. */
  scheduleNext: () => void
  /** Cancel a pending attempt and reset the backoff — recovery succeeded, or
   *  the watch is being disposed. */
  cancel: () => void
}

/**
 * Drives geometric-backoff retries (30s, 1m, 2m, ... capped at 15m) of a
 * caller-supplied recovery attempt. `tryRecover` resolves true once recovered
 * (stopping the cycle) or false to arm the next backoff step.
 */
export function createPollingFallbackRetry(
  tryRecover: () => Promise<boolean>
): PollingFallbackRetry {
  let timer: ReturnType<typeof setTimeout> | null = null
  let attempt = 0
  const scheduleNext = (): void => {
    if (timer) {
      return
    }
    const delay = Math.min(
      POLLING_FALLBACK_RETRY_BASE_MS * 2 ** attempt,
      POLLING_FALLBACK_RETRY_MAX_MS
    )
    attempt++
    timer = setTimeout(() => {
      timer = null
      void tryRecover().then((recovered) => {
        if (!recovered) {
          scheduleNext()
        }
      })
    }, delay)
    timer.unref?.()
  }
  return {
    scheduleNext,
    cancel: () => {
      attempt = 0
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
    }
  }
}

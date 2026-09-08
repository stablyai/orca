import { withReconnectJitter } from '../../../src/shared/reconnect-jitter'

// Why: the refresh effect restarts from zero on every client swap and the staged bytes are dropped
// with it, so a flapping link re-downloads the whole bundle back to back on cellular data. The delay
// escalates per attempt that never reached a completed download and stops at a ceiling; a user-driven
// retry starts the ladder over.
const REFRESH_RETRY_BASE_DELAY_MS = 1_000
const REFRESH_RETRY_MAX_DELAY_MS = 30_000

export function mobileWebPackageRefreshDelayMs(
  unfinishedAttempts: number,
  random: () => number = Math.random
): number {
  if (unfinishedAttempts <= 0) {
    return 0
  }
  return withReconnectJitter(
    Math.min(
      REFRESH_RETRY_BASE_DELAY_MS * 2 ** (unfinishedAttempts - 1),
      REFRESH_RETRY_MAX_DELAY_MS
    ),
    random
  )
}

/** Resolves false when the wait was abandoned, so the caller drops the attempt instead of starting. */
export function waitBeforeMobileWebPackageRefresh(
  delayMs: number,
  signal: AbortSignal
): Promise<boolean> {
  if (signal.aborted) {
    return Promise.resolve(false)
  }
  if (delayMs <= 0) {
    return Promise.resolve(true)
  }
  return new Promise((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve(false)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve(true)
    }, delayMs)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

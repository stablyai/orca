import type { WaitForLocalWatcherRetry } from './filesystem-watcher-local-capacity'

// Covers plan9 coming up after a distro (re)starts; a root still missing after these is gone.
export const WSL_ROOT_STAT_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000]

const attemptsByRoot = new Map<string, number>()

/**
 * A WSL root whose stat fails, e.g. a deferred re-watch draining while its distro's file share is
 * still starting, waits and retries rather than being remembered unwatchable for good. Null once
 * the bounded retries are spent.
 */
export function nextWslRootStatRetry(rootKey: string): WaitForLocalWatcherRetry | null {
  const attempt = attemptsByRoot.get(rootKey) ?? 0
  const delayMs = WSL_ROOT_STAT_RETRY_DELAYS_MS[attempt]
  if (delayMs === undefined) {
    attemptsByRoot.delete(rootKey)
    return null
  }
  attemptsByRoot.set(rootKey, attempt + 1)
  return (retry) => {
    const timer = setTimeout(() => void retry(), delayMs)
    timer.unref?.()
    return () => clearTimeout(timer)
  }
}

export function clearWslRootStatRetry(rootKey: string): void {
  attemptsByRoot.delete(rootKey)
}

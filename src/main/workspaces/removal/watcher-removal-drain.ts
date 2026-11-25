// One absolute removal deadline bounds all install/unsubscribe drains, including wedged native subscriptions.

export const WATCHER_REMOVAL_DRAIN_BUDGET_MS = 60_000
// Reserve time for the final unsubscribe that releases native handles on slow Windows/WSL hosts.
export const WATCHER_REMOVAL_FINAL_DRAIN_RESERVE_MS = 10_000

export type WatcherRemovalDeadline = {
  remainingMs(reserveMs?: number): number
}

export function createWatcherRemovalDeadline(
  budgetMs: number = WATCHER_REMOVAL_DRAIN_BUDGET_MS
): WatcherRemovalDeadline {
  const expiresAt = Date.now() + budgetMs
  return {
    remainingMs: (reserveMs = 0) => Math.max(0, expiresAt - Date.now() - reserveMs)
  }
}

export type WatcherRemovalDrainOutcome = 'settled' | 'timeout' | 'skipped'

export type WatcherRemovalDrainOptions = {
  /** Budget this drain must leave behind for the removal's final unsubscribe. */
  reserveMs?: number
}

/** Bound unsettled waits by the removal deadline; propagate actual teardown failures to fail deletion closed. */
export async function drainBeforeWatcherRemoval(
  promise: Promise<unknown> | undefined,
  deadline: WatcherRemovalDeadline,
  label: string,
  options: WatcherRemovalDrainOptions = {}
): Promise<WatcherRemovalDrainOutcome> {
  if (!promise) {
    return 'skipped'
  }
  const waitMs = deadline.remainingMs(options.reserveMs)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const settled = promise.then(() => 'settled' as const)
    const outcome = await Promise.race([
      settled,
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), waitMs)
      })
    ])
    if (outcome === 'timeout') {
      // Abandoned native work may reject later; consume it to avoid crashing main.
      void settled.catch(() => {})
      // Budget splits distinguish slow completion from wedged teardown in production traces.
      console.warn(
        `[watcher-removal] Timed out waiting for ${label} after ${waitMs}ms ` +
          `(${deadline.remainingMs()}ms of the removal budget left); continuing removal`
      )
    }
    return outcome
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer)
    }
  }
}

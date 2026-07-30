// Why: worktree deletion has to drain in-flight watcher installs/unsubscribes before Git removes the
// tree, and a wedged native subscribe can leave those promises unsettled forever. Independent per-await
// timeouts would compose (two close passes x two drains), so one removal shares one absolute deadline.

export const WATCHER_REMOVAL_DRAIN_BUDGET_MS = 60_000
// Why: the final live unsubscribe is the drain that actually releases the native handle. Earlier drains
// leave it this slice so a slow-but-finishing unsubscribe on Windows/WSL isn't abandoned at ~0ms left.
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

/** Await `promise` until the removal deadline expires. Rejections still propagate so genuine
 *  teardown failures keep failing the delete closed; only an unsettled wait is abandoned. */
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
      // Why: nobody awaits the abandoned promise anymore, so a late rejection (an aborted native
      // subscribe finally reporting) would be an unhandled rejection — fatal in the main process.
      void settled.catch(() => {})
      // Why log the budget split: production traces need "slow but finishing" separable from "wedged".
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

// The one backoff every in-memory retry of background bookkeeping uses: from 1 s to 30 s, given up
// after a bounded run (about three minutes), so nothing is owed forever.

export const RECONCILIATION_BACKOFF_MS = { first: 1_000, max: 30_000 } as const
/** Consecutive failed attempts after which a retry gives up. */
export const RECONCILIATION_MAX_FAILED_ATTEMPTS = 10

/** The wait before the next try, after `failures` consecutive failed ones. */
export function reconciliationBackoffDelay(failures: number): number {
  return Math.min(
    RECONCILIATION_BACKOFF_MS.max,
    RECONCILIATION_BACKOFF_MS.first * 2 ** (failures - 1)
  )
}

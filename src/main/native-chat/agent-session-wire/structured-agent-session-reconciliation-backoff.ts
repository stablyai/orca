// The one backoff the host's retry of background bookkeeping uses: from 1 s to 2 s, given up after
// about 3 minutes of rounds failing in a row, so nothing is owed forever. Short: a background write
// fails at once, so a round is cheap, waiting long only delays work a lifted lock already allows,
// and nothing announces the lift.

export const RECONCILIATION_BACKOFF_MS = { first: 1_000, max: 2_000 } as const
/** The time since an episode's first refused round after which its retry gives up. */
export const RECONCILIATION_GIVE_UP_MS = 180_000

/** The wait before the next try, after `failures` consecutive failed ones. */
export function reconciliationBackoffDelay(failures: number): number {
  return Math.min(
    RECONCILIATION_BACKOFF_MS.max,
    RECONCILIATION_BACKOFF_MS.first * 2 ** (failures - 1)
  )
}

const MIB = 1024 * 1024
// Each copy rewrites the live data, so a file whose copies keep going stale waits longer each time: an
// hour after the first, doubling up to a day. After this many it gives up, and the file keeps its size.
export const MAX_COPIES = 3
export const ATTEMPT_SPACING_MS = 60 * 60_000
export const MAX_ATTEMPT_SPACING_MS = 24 * ATTEMPT_SPACING_MS
// The copy blocks no one; this only bounds the disk and CPU it uses, at a slow disk's pace.
export const MIN_COPY_BUDGET_MS = 120_000
const SLOW_COPY_BYTES_PER_MS = (4 * MIB) / 1000
const MAX_BUDGET_DOUBLINGS = 6
// Node fires a longer timer after 1 ms.
const MAX_TIMER_MS = 2_147_483_647

/** Since the last copy started; an hour even when none went unused yet (a quit or crash cut it short). */
export function attemptSpacingMs(attempts: number): number {
  return Math.min(ATTEMPT_SPACING_MS * 2 ** Math.max(attempts - 1, 0), MAX_ATTEMPT_SPACING_MS)
}

/** Doubled with each attempt, so a disk slower than assumed still finishes one in the end. */
export function copyBudgetMs(liveBytes: number, attempts: number): number {
  return Math.min(
    Math.max(MIN_COPY_BUDGET_MS, Math.round(liveBytes / SLOW_COPY_BYTES_PER_MS)) *
      2 ** Math.min(attempts - 1, MAX_BUDGET_DOUBLINGS),
    MAX_TIMER_MS
  )
}

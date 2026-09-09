const DAY_MS = 86_400_000
const HISTORY_DAYS_MAX = 3_650

/**
 * The retention window, as the indexer's callers state it and as the store
 * consumes it. Settings storage is PR 3b's problem; this is the arithmetic.
 */
export function normalizeSessionSearchHistoryDays(value: number | null): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return null
  }
  // Why floor then re-check: a fractional day floors to 0, which reads as "all
  // history" on one side and "now" on the other; make the two agree.
  const days = Math.floor(value)
  return days <= 0 ? null : Math.min(HISTORY_DAYS_MAX, days)
}

/** The oldest transcript mtime worth indexing; null means no bound. */
export function sessionSearchHistoryCutoffMs(
  historyDays: number | null,
  nowMs: number
): number | null {
  const days = normalizeSessionSearchHistoryDays(historyDays)
  return days === null ? null : nowMs - days * DAY_MS
}

/** A finite bound tighter than before: rows outside it are purged. */
export function narrowsSessionSearchHistory(previous: number | null, next: number | null): boolean {
  const from = normalizeSessionSearchHistoryDays(previous)
  const to = normalizeSessionSearchHistoryDays(next)
  return to !== null && (from === null || to < from)
}

/** A wider bound: files skipped under the old cutoff have never been read. */
export function widensSessionSearchHistory(previous: number | null, next: number | null): boolean {
  const from = normalizeSessionSearchHistoryDays(previous)
  const to = normalizeSessionSearchHistoryDays(next)
  return from !== null && (to === null || to > from)
}

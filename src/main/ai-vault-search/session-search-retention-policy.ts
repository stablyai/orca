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

/** What a change to the window asks of whoever owns the index. */
export type SessionSearchRetentionChange = 'purge' | 'resweep' | 'nothing'

/**
 * The retention window an indexer is currently keeping, and what moving it
 * costs. The arithmetic and the decision live together because the two have to
 * agree: a purge that uses one cutoff while the accept check holds another
 * deletes rows the very next candidate re-indexes.
 */
export class SessionSearchRetentionWindow {
  constructor(private historyDays: number | null) {}

  /** The oldest transcript mtime worth indexing right now, or null for all history. */
  cutoffMs(nowMs: number): number | null {
    return sessionSearchHistoryCutoffMs(this.historyDays, nowMs)
  }

  /**
   * Moves the window and says what it asks for: narrowing purges the rows now
   * outside it, widening needs a sweep because the files beyond the old bound
   * were never read at all.
   */
  moveTo(historyDays: number | null): SessionSearchRetentionChange {
    const previous = this.historyDays
    this.historyDays = historyDays
    if (narrowsSessionSearchHistory(previous, historyDays)) {
      return 'purge'
    }
    return widensSessionSearchHistory(previous, historyDays) ? 'resweep' : 'nothing'
  }
}

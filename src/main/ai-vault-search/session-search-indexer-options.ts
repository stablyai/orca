import type { SessionSearchClock } from './session-search-clock'
import type { SessionSearchScanRoots } from './session-search-scan-roots'

/** Default cycle. Long enough that a machine with thousands of transcripts is
 * not re-statting continuously, short enough that a live conversation shows up
 * while the user is still in it. */
export const DEFAULT_SESSION_SEARCH_RECONCILE_INTERVAL_MS = 20_000
/** Newest-N per agent root: the same recency rule the session sidebar applies. */
export const DEFAULT_SESSION_SEARCH_RECENT_PER_AGENT = 12
/**
 * A quarter of the interval: the only bound on how long one pass reads for.
 *
 * The timer re-arms after a pass settles, so a pass that spends its whole
 * deadline is followed by a full interval of quiet — five seconds of reading in
 * every twenty-five, a fifth of the wall clock, and the stated ceiling is a
 * quarter. Files the deadline cut off go back on the queue at full speed rather
 * than being read slowly, which is what a load-average back-off did instead.
 */
export const DEFAULT_SESSION_SEARCH_PASS_DEADLINE_FRACTION = 4
/**
 * Cycles between whole-machine sweeps: five minutes at the default interval.
 *
 * A sweep is the only pass that sees a file nothing has told the indexer about
 * — an old transcript deleted, a root that came back, a tree restored from a
 * backup — so the cadence is what replaces every re-arm-on-recovery rule. A
 * warm sweep is stats and readdirs, not reads, because the pass skips anything
 * the index already covers at its current stat.
 */
export const DEFAULT_SESSION_SEARCH_FULL_SWEEP_EVERY_CYCLES = 15

/**
 * Everything an indexer is. Immutable after construction: a settings change is
 * `close()` and a new instance, which is also how the index is thrown away
 * (`close()`, `removeSessionSearchDatabase(databasePath)`, construct again).
 */
export type SessionSearchIndexerOptions = {
  databasePath: string
  roots: SessionSearchScanRoots
  /** null = all history; otherwise only transcripts modified within this many days. */
  historyDays: number | null
  clock?: SessionSearchClock
  reconcileIntervalMs?: number
  recentPerAgent?: number
  /** Wall time one pass may read for; the rest goes back on the queue. */
  passDeadlineMs?: number
  /** Cycles between whole-machine sweeps. */
  fullSweepEveryCycles?: number
  /** Directories one pass walks proving deletions; the rest are checked next pass. */
  retirementChecksPerCycle?: number
  onError?: (error: unknown) => void
}

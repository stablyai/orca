import type { SessionSearchClock } from './session-search-clock'
import type { SessionSearchBudget } from './session-search-reconcile-budget'
import type { SessionSearchScanRoots } from './session-search-scan-roots'

/** Default cycle. Long enough that a machine with thousands of transcripts is
 * not re-statting continuously, short enough that a live conversation shows up
 * while the user is still in it. */
export const DEFAULT_SESSION_SEARCH_RECONCILE_INTERVAL_MS = 20_000
/** Newest-N per agent root: the same recency rule the session sidebar applies. */
export const DEFAULT_SESSION_SEARCH_RECENT_PER_AGENT = 12

export type SessionSearchIndexerOptions = {
  databasePath: string
  roots: SessionSearchScanRoots
  /** null = all history; otherwise only transcripts modified within this many days. */
  historyDays: number | null
  clock?: SessionSearchClock
  reconcileIntervalMs?: number
  recentPerAgent?: number
  budget?: SessionSearchBudget
  /** What one pass may spend draining the backfill, on top of the cycle budget. */
  backfillBudget?: SessionSearchBudget
  /** Test seam only; production uses `DEFAULT_SESSION_SEARCH_PENDING_LIMIT`. */
  pendingLimit?: number
  /** Directories one pass walks proving deletions; the rest are checked next pass. */
  retirementChecksPerCycle?: number
  /** Backfill pacing; tests replace it so a pass is not at the mercy of load. */
  pace?: (signal?: AbortSignal) => Promise<void>
  onError?: (error: unknown) => void
}

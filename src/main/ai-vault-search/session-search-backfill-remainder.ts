import type { SessionFileCandidate } from '../ai-vault/session-scanner-types'
import { runSessionSearchIndexPass } from './session-search-index-pass'
import type { SessionSearchIndexingStatus } from './session-search-indexing-status'
import type { SessionSearchCycleAllowance } from './session-search-reconcile-budget'
import type { SessionSearchStore } from './session-search-store'

/**
 * Sweep leftovers held between passes.
 *
 * Why a bound at all, and why this one: a sweep's plan is the whole machine,
 * and its allowance means the plan is read over many passes. Holding every
 * entry would make a first run's memory a function of the user's disk. What the
 * queue cannot hold is not dropped — the sweep is re-armed once the remainder
 * drains, and discovery finds the rest again, at the cost of one extra
 * discovery per 5,000 files. With the store's 20,000 re-read records and the
 * 2,000-entry scheduled queue, the worst case retained across all three is
 * 27,000 candidate records.
 */
export const DEFAULT_SESSION_SEARCH_BACKFILL_REMAINDER_LIMIT = 5_000

/** The part of the last sweep's plan its allowance had no room for. */
export class SessionSearchBackfillRemainder {
  private entries = new Map<string, SessionFileCandidate>()
  private truncated = false

  constructor(private readonly limit = DEFAULT_SESSION_SEARCH_BACKFILL_REMAINDER_LIMIT) {}

  get size(): number {
    return this.entries.size
  }

  get paths(): Iterable<string> {
    return this.entries.keys()
  }

  /** Keeps what fits, in order, and records that the rest needs rediscovering. */
  remember(candidates: readonly SessionFileCandidate[]): void {
    for (const candidate of candidates) {
      if (this.entries.size >= this.limit && !this.entries.has(candidate.file.path)) {
        this.truncated = true
        break
      }
      this.entries.set(candidate.file.path, candidate)
    }
  }

  /**
   * Reads what the last sweep planned and had no allowance for, one allowance
   * at a time. Rolling the remainder over rather than re-discovering keeps a
   * first run off the 33 s cold discovery every pass.
   *
   * This runs inside the reconcile cycle, so `overdue` is what keeps the
   * recent-N-per-interval promise: without it the pacer's load back-off can
   * hold one pass for far longer than the interval and every recency check
   * queues behind it.
   *
   * Returns true once a plan too large for the queue has been read through:
   * discovery still owes the files the queue could not hold, and one sweep
   * settles that debt.
   */
  async drain(
    store: SessionSearchStore,
    allowance: SessionSearchCycleAllowance,
    status: SessionSearchIndexingStatus,
    pace: (signal?: AbortSignal) => Promise<void>,
    signal: AbortSignal,
    overdue?: () => boolean
  ): Promise<boolean> {
    if (this.entries.size === 0) {
      return false
    }
    const queued = [...this.entries.values()]
    this.entries = new Map()
    allowance.reset()
    try {
      const pass = await runSessionSearchIndexPass(store, queued, {
        signal,
        pace,
        allowance,
        overdue,
        onIndexed: (_candidate, bytes) => status.indexed(bytes),
        onFailed: () => status.failed()
      })
      this.remember(pass.deferred)
    } catch (error) {
      if (!signal.aborted) {
        throw error
      }
      // A pause or a close, not a failure: the plan goes back untouched rather
      // than losing the files this pass had not reached.
      this.remember(queued)
      return false
    }
    if (this.entries.size > 0 || !this.truncated) {
      return false
    }
    this.truncated = false
    return true
  }

  clear(): void {
    this.entries = new Map()
    this.truncated = false
  }
}

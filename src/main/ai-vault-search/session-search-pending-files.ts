import type { SessionFileCandidate } from '../ai-vault/session-scanner-types'

export type SessionSearchPendingFile = {
  path: string
  /** Null when a caller named a path the last sweep did not discover. */
  candidate: SessionFileCandidate | null
  /** The stored cursor for this path is not to be trusted; re-read regardless. */
  forced: boolean
}

/**
 * Why 2,000 and not the store's 20,000: the two queues fill by different
 * mechanisms, so one number would be wrong for one of them. The store's set is
 * filled by the reader at machine speed during a pause, so it needs headroom
 * proportional to the transcripts on the disk. This one is filled by a cycle's
 * budget rollover, bounded by a single recent-window discovery at a few
 * hundred, and by `invalidate()`, where 2,000 outstanding requests already
 * means the caller is malfunctioning. Both retain a candidate per entry, so the
 * pair is the memory bound worth stating: 22,000 records, not 40,000.
 */
export const DEFAULT_SESSION_SEARCH_PENDING_LIMIT = 2_000

/**
 * Scheduled re-reads: insertion ordered, deduplicated by path, capped.
 *
 * Why bounded: pausing stops the drain but not the callers, so an hour of
 * `invalidate()` plus rolled-over reconcile work would grow without limit in
 * the scanner process. Oldest goes first, because the newest entry is the one a
 * user is most likely waiting on.
 *
 * Separate from the store's stale set, and deliberately not merged into it. The
 * store records that the index has a hole in a file; this records that work was
 * scheduled and is not done yet. Feeding budget leftovers through `markStale`
 * would turn every deferred append into a whole re-read.
 */
export class SessionSearchPendingFiles {
  private readonly entries = new Map<string, SessionSearchPendingFile>()
  private dropped = 0

  constructor(private readonly limit: number) {}

  add(entry: SessionSearchPendingFile): void {
    const existing = this.entries.get(entry.path)
    if (existing) {
      // Keep the newer candidate and never downgrade a forced re-read.
      existing.candidate = entry.candidate ?? existing.candidate
      existing.forced ||= entry.forced
      return
    }
    this.entries.set(entry.path, { ...entry })
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next()
      if (oldest.done) {
        break
      }
      this.entries.delete(oldest.value)
      this.dropped += 1
    }
  }

  /** Hands the queue to the cycle that will read it and empties it. */
  drain(): SessionSearchPendingFile[] {
    const queued = [...this.entries.values()]
    this.entries.clear()
    return queued
  }

  clear(): void {
    this.entries.clear()
    this.dropped = 0
  }

  get size(): number {
    return this.entries.size
  }

  /** For counting this queue against another one by path rather than by sum. */
  get paths(): string[] {
    return [...this.entries.keys()]
  }

  get droppedCount(): number {
    return this.dropped
  }
}

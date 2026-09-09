import type { SessionFileCandidate } from '../ai-vault/session-scanner-types'

export type SessionSearchPendingFile = {
  path: string
  /** Null when a caller named a path the last sweep did not discover. */
  candidate: SessionFileCandidate | null
  /** The stored cursor for this path is not to be trusted; re-read regardless. */
  forced: boolean
}

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
 * would turn every deferred append into a whole re-read. The two share one
 * ceiling, set by the indexer, which is the only thing that owns both.
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

  get droppedCount(): number {
    return this.dropped
  }
}

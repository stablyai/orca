import { MAX_CODEX_TOKEN_USAGE_THREADS } from './codex-structured-journal-limits'

/** Latest reported token total per thread, kept regardless of roster membership: a
 *  usage frame can arrive before the child's first activity item, and filtering at
 *  receipt would lose it permanently. LRU-capped at MAX_CODEX_TOKEN_USAGE_THREADS. */
export class CodexThreadTokenTotals {
  private readonly totals = new Map<string, number>()

  /** A running total: the newest frame REPLACES the previous one. Summing updates
   *  would multiply a single child's usage by its frame count. */
  record(threadId: string, totalTokens: number): void {
    // Re-insert so eviction sees recency: `set` on an existing key keeps its
    // original position, which would age out an active thread.
    this.totals.delete(threadId)
    this.totals.set(threadId, totalTokens)
    while (this.totals.size > MAX_CODEX_TOKEN_USAGE_THREADS) {
      const oldest = this.totals.keys().next().value
      if (typeof oldest !== 'string') {
        break
      }
      this.totals.delete(oldest)
    }
  }

  get(threadId: string): number | undefined {
    return this.totals.get(threadId)
  }

  clear(): void {
    this.totals.clear()
  }
}

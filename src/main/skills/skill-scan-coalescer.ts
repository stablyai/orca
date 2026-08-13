/** `cached` is false when this call did the filesystem work, for diagnostics. */
export type SkillScanOutcome<T> = { value: T; cached: boolean }

export type SkillScanRunOptions = {
  /** 0 keeps nothing after the scan settles, so the entry only dedups concurrent callers. */
  ttlMs: number
  /** Skip every cached and in-flight result and re-read disk. */
  refresh?: boolean
}

type CacheEntry<T> = { value: T; expiresAt: number }
type PendingEntry<T> = { promise: Promise<T>; startedAt: number }

// Why: a root on a stalled network mount can leave a readdir that never settles.
// Joining it forever would make one wedged mount permanently wedge discovery for
// every later caller — worse than before this cache existed, where each caller at
// least retried. Past this age a new caller starts its own scan instead; the old
// promise is dropped, so at most one pending entry per key survives.
const MAX_JOINABLE_SCAN_AGE_MS = 30_000

/**
 * Shares one filesystem scan between concurrent callers and, optionally, reuses
 * its result for a short window.
 *
 * Keys are used verbatim — callers must not normalize case, because two paths
 * that differ only by case can be two different targets on Linux.
 */
export class SkillScanCoalescer<T> {
  private readonly pending = new Map<string, PendingEntry<T>>()
  private readonly cache = new Map<string, CacheEntry<T>>()

  constructor(
    private readonly maximumEntries: number,
    private readonly now: () => number = Date.now
  ) {}

  async run(
    key: string,
    options: SkillScanRunOptions,
    task: () => Promise<T>
  ): Promise<SkillScanOutcome<T>> {
    if (options.refresh) {
      // Why: a forced caller is answering a mutation it just made, so it must not
      // join a scan that may have started before that mutation. Concurrent forced
      // callers therefore duplicate; they are rare (install / explicit recheck).
      this.cache.delete(key)
      return { value: await this.start(key, options.ttlMs, task), cached: false }
    }
    const fresh = this.readFresh(key)
    if (fresh) {
      return { value: fresh.value, cached: true }
    }
    const inFlight = this.pending.get(key)
    if (inFlight && this.now() - inFlight.startedAt < MAX_JOINABLE_SCAN_AGE_MS) {
      return { value: await inFlight.promise, cached: true }
    }
    return { value: await this.start(key, options.ttlMs, task), cached: false }
  }

  /** Drop every cached and in-flight entry (e.g. after a skill update run). */
  clear(): void {
    this.cache.clear()
    this.pending.clear()
  }

  private start(key: string, ttlMs: number, task: () => Promise<T>): Promise<T> {
    const promise = task()
      .then((value) => {
        // Why: owning the pending slot is what makes a scan publishable, and it is
        // per key by construction. Deleting the cache entry is not enough to
        // invalidate — a scan that began before the mutation resolves afterwards
        // and would re-cache its pre-mutation result with a fresh lifetime. This
        // one check covers all three ways it can be superseded: `clear()` empties
        // `pending`, a refresh overwrites the slot, and so does the replacement
        // for a scan abandoned past MAX_JOINABLE_SCAN_AGE_MS.
        if (ttlMs > 0 && this.pending.get(key)?.promise === promise) {
          this.write(key, value, ttlMs)
        }
        return value
      })
      .finally(() => {
        // Why: a newer forced scan may already own this key; only the entry that
        // registered itself may remove itself.
        if (this.pending.get(key)?.promise === promise) {
          this.pending.delete(key)
        }
      })
    // Why: rejections must not surface as an unhandled rejection on the shared
    // promise before the caller that started it awaits.
    promise.catch(() => undefined)
    this.pending.set(key, { promise, startedAt: this.now() })
    return promise
  }

  private readFresh(key: string): CacheEntry<T> | null {
    const entry = this.cache.get(key)
    if (!entry) {
      return null
    }
    if (entry.expiresAt <= this.now()) {
      this.cache.delete(key)
      return null
    }
    // Refresh recency so a hot root outlives a one-off target under the bound.
    this.cache.delete(key)
    this.cache.set(key, entry)
    return entry
  }

  private write(key: string, value: T, ttlMs: number): void {
    this.cache.delete(key)
    this.cache.set(key, { value, expiresAt: this.now() + ttlMs })
    while (this.cache.size > this.maximumEntries) {
      const oldestKey = this.cache.keys().next().value
      if (oldestKey === undefined) {
        break
      }
      this.cache.delete(oldestKey)
    }
  }
}

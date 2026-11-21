export type SkillScanOutcome<T> = { value: T; cached: boolean }

export type SkillScanRunOptions = {
  /** 0 keeps nothing after the scan settles, so the entry only dedups concurrent callers. */
  ttlMs: number
  /** Skip every cached and in-flight result and re-read disk. */
  refresh?: boolean
}

type CacheEntry<T> = { value: T; expiresAt: number }
type PendingEntry<T> = { promise: Promise<T>; startedAt: number; abort: AbortController }

// Stop joining scans stuck on mounts past this age; replacements retry while retaining one pending entry per key.
const MAX_JOINABLE_SCAN_AGE_MS = 30_000

// Budget abandoned, unsettled scans globally, not healthy concurrent roots. One stalled root may spend multiple slots, one per age window; completion frees slots.
const MAX_ABANDONED_SCANS = 16

/** Refuse excess stalled walks without exposing the absolute-path key to clients. */
export class SkillScanShedError extends Error {
  constructor() {
    super('Skill scan was shed: too many stalled scans')
    this.name = 'SkillScanShedError'
  }
}

/** Shed/abort/timeout means unavailable. Name matching is narrow because local filesystem errors are caught inside scans; only their signal errors escape. */
export function isSkillRootUnavailableError(error: unknown): boolean {
  return (
    error instanceof SkillScanShedError ||
    (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError'))
  )
}

/** Coalesce scans and optionally retain results. Keys remain case-sensitive so distinct Linux paths cannot alias. */
export class SkillScanCoalescer<T> {
  private readonly pending = new Map<string, PendingEntry<T>>()
  private readonly cache = new Map<string, CacheEntry<T>>()
  private abandonedScans = 0

  constructor(
    private readonly maximumEntries: number,
    private readonly now: () => number = Date.now
  ) {}

  async run(
    key: string,
    options: SkillScanRunOptions,
    task: (signal: AbortSignal) => Promise<T>
  ): Promise<SkillScanOutcome<T>> {
    if (options.refresh) {
      // Forced scans must observe post-mutation disk. Keep superseded healthy callers alive; per-key publish ownership fences stale results.
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
    if (inFlight) {
      if (this.abandonedScans >= MAX_ABANDONED_SCANS) {
        // Keep stalled pending entry so the mount can recover without another walk while replacement budget is exhausted.
        throw new SkillScanShedError()
      }
      // Abandoned scans must stop issuing more filesystem work once a replacement takes ownership.
      this.abandonedScans += 1
      inFlight.abort.abort()
      void inFlight.promise
        .catch(() => undefined)
        .finally(() => {
          this.abandonedScans -= 1
        })
    }
    return { value: await this.start(key, options.ttlMs, task), cached: false }
  }

  /** Invalidate cached/pending results after disk mutations. */
  clear(): void {
    this.cache.clear()
    this.pending.clear()
  }

  private start(key: string, ttlMs: number, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const abort = new AbortController()
    const promise = task(abort.signal)
      .then((value) => {
        // Publish only while owning this key: clear, refresh and age replacement must all fence pre-mutation results.
        if (ttlMs > 0 && this.pending.get(key)?.promise === promise) {
          this.write(key, value, ttlMs)
        }
        return value
      })
      .finally(() => {
        // Only the registered owner may clear pending; forced replacement may already own it.
        if (this.pending.get(key)?.promise === promise) {
          this.pending.delete(key)
        }
      })
    // Contain shared rejections before the initiating caller starts awaiting.
    promise.catch(() => undefined)
    this.pending.set(key, { promise, startedAt: this.now(), abort })
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

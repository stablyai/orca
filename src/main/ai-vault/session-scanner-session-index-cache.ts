export type SessionIndexIdentity = {
  changeTimeMs: number
  mtimeMs: number
  sizeBytes: number
}

type SessionIndexCacheEntry<V> = {
  expiresAt: number
  generation: number
  identity: SessionIndexIdentity
  timer: NodeJS.Timeout | null
  value: Promise<V>
}

export const SESSION_INDEX_CACHE_MAX_PATHS = 64
// Active Vault scans refresh this window; closing the surface releases parsed
// index maps soon without making a live session reread its index on every scan.
export const SESSION_INDEX_CACHE_TTL_MS = 5 * 60_000

// Why: agents whose sessions share one registry file (Kimi's session_index.jsonl, Junie's
// index.jsonl) would re-read it once per session — O(n^2) on a scan. Memoize by path plus
// file identity, generic over the parsed value each agent needs.
export class SessionIndexCache<V = Map<string, string>> {
  private readonly entries = new Map<string, SessionIndexCacheEntry<V>>()
  private minimumCacheGeneration = 0
  private nextGeneration = 0

  beginRead(): number {
    this.nextGeneration += 1
    return this.nextGeneration
  }

  clear(): void {
    for (const entry of this.entries.values()) {
      if (entry.timer) {
        clearTimeout(entry.timer)
      }
    }
    this.entries.clear()
    // Why: a read already awaiting stat/load when its owner clears the cache
    // may finish later, but must not silently recreate the released entry.
    this.minimumCacheGeneration = this.nextGeneration + 1
  }

  delete(indexPath: string, generation = Number.POSITIVE_INFINITY): void {
    const entry = this.entries.get(indexPath)
    if (entry && entry.generation <= generation) {
      this.forget(indexPath, entry)
    }
  }

  get(
    indexPath: string,
    identity: SessionIndexIdentity,
    generation: number,
    load: () => Promise<V>
  ): Promise<V> {
    if (generation < this.minimumCacheGeneration) {
      return load()
    }
    const cached = this.entries.get(indexPath)
    const now = Date.now()
    if (cached && cached.expiresAt > now && identitiesMatch(cached.identity, identity)) {
      this.remember(indexPath, cached, now)
      return cached.value
    }
    if (cached && cached.generation > generation) {
      // Why: a slower, older stat must not replace a newer file generation
      // that another concurrent scan already cached for the same path.
      return load()
    }

    const entry: SessionIndexCacheEntry<V> = {
      expiresAt: now + SESSION_INDEX_CACHE_TTL_MS,
      generation,
      identity,
      timer: null,
      value: load()
    }
    this.remember(indexPath, entry, now)
    return entry.value
  }

  has(indexPath: string): boolean {
    return this.entries.has(indexPath)
  }

  get size(): number {
    return this.entries.size
  }

  private forget(indexPath: string, entry: SessionIndexCacheEntry<V>): void {
    if (this.entries.get(indexPath) !== entry) {
      return
    }
    if (entry.timer) {
      clearTimeout(entry.timer)
    }
    this.entries.delete(indexPath)
  }

  private remember(indexPath: string, entry: SessionIndexCacheEntry<V>, now: number): void {
    const replaced = this.entries.get(indexPath)
    if (replaced?.timer && replaced !== entry) {
      clearTimeout(replaced.timer)
    }
    if (entry.timer) {
      clearTimeout(entry.timer)
    }
    entry.expiresAt = now + SESSION_INDEX_CACHE_TTL_MS
    entry.timer = setTimeout(() => this.forget(indexPath, entry), SESSION_INDEX_CACHE_TTL_MS)
    entry.timer.unref()
    this.entries.delete(indexPath)
    this.entries.set(indexPath, entry)

    while (this.entries.size > SESSION_INDEX_CACHE_MAX_PATHS) {
      const oldest = this.entries.entries().next().value
      if (!oldest) {
        return
      }
      this.forget(oldest[0], oldest[1])
    }
  }
}

function identitiesMatch(left: SessionIndexIdentity, right: SessionIndexIdentity): boolean {
  return (
    left.changeTimeMs === right.changeTimeMs &&
    left.mtimeMs === right.mtimeMs &&
    left.sizeBytes === right.sizeBytes
  )
}

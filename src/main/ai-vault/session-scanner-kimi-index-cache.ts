export type KimiSessionIndexIdentity = {
  changeTimeMs: number
  mtimeMs: number
  sizeBytes: number
}

type KimiSessionIndexCacheEntry = {
  expiresAt: number
  generation: number
  identity: KimiSessionIndexIdentity
  timer: NodeJS.Timeout | null
  value: Promise<Map<string, string>>
}

export const KIMI_WORK_DIR_CACHE_MAX_INDEX_PATHS = 64
// Active Vault scans refresh this window; closing the surface releases parsed
// index maps soon without making a live Kimi session reread on every scan.
export const KIMI_WORK_DIR_CACHE_TTL_MS = 5 * 60_000

export class KimiSessionIndexCache {
  private readonly entries = new Map<string, KimiSessionIndexCacheEntry>()
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
    identity: KimiSessionIndexIdentity,
    generation: number,
    load: () => Promise<Map<string, string>>
  ): Promise<Map<string, string>> {
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

    const entry: KimiSessionIndexCacheEntry = {
      expiresAt: now + KIMI_WORK_DIR_CACHE_TTL_MS,
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

  private forget(indexPath: string, entry: KimiSessionIndexCacheEntry): void {
    if (this.entries.get(indexPath) !== entry) {
      return
    }
    if (entry.timer) {
      clearTimeout(entry.timer)
    }
    this.entries.delete(indexPath)
  }

  private remember(indexPath: string, entry: KimiSessionIndexCacheEntry, now: number): void {
    const replaced = this.entries.get(indexPath)
    if (replaced?.timer && replaced !== entry) {
      clearTimeout(replaced.timer)
    }
    if (entry.timer) {
      clearTimeout(entry.timer)
    }
    entry.expiresAt = now + KIMI_WORK_DIR_CACHE_TTL_MS
    entry.timer = setTimeout(() => this.forget(indexPath, entry), KIMI_WORK_DIR_CACHE_TTL_MS)
    entry.timer.unref()
    this.entries.delete(indexPath)
    this.entries.set(indexPath, entry)

    while (this.entries.size > KIMI_WORK_DIR_CACHE_MAX_INDEX_PATHS) {
      const oldest = this.entries.entries().next().value
      if (!oldest) {
        return
      }
      this.forget(oldest[0], oldest[1])
    }
  }
}

function identitiesMatch(
  left: KimiSessionIndexIdentity,
  right: KimiSessionIndexIdentity
): boolean {
  return (
    left.changeTimeMs === right.changeTimeMs &&
    left.mtimeMs === right.mtimeMs &&
    left.sizeBytes === right.sizeBytes
  )
}

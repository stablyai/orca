export type KimiSessionIndexIdentity = {
  dev?: number
  ino?: number
  changeTimeMs: number
  mtimeMs: number
  sizeBytes: number
}

type KimiSessionIndexCacheEntry<T> = {
  expiresAt: number
  generation: number
  identity: KimiSessionIndexIdentity
  timer: NodeJS.Timeout | null
  value: Promise<T>
}

export const KIMI_WORK_DIR_CACHE_MAX_INDEX_PATHS = 64
// Active scans refresh expiry; idle surfaces release parsed index maps.
export const KIMI_WORK_DIR_CACHE_TTL_MS = 5 * 60_000

export class KimiSessionIndexCache<T = Map<string, string>> {
  private readonly entries = new Map<string, KimiSessionIndexCacheEntry<T>>()
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
    // Reads started before clear must not repopulate released entries.
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
    load: (previous: Promise<T> | undefined) => Promise<T>
  ): Promise<T> {
    if (generation < this.minimumCacheGeneration) {
      return load(undefined)
    }
    const cached = this.entries.get(indexPath)
    const now = Date.now()
    if (cached && cached.expiresAt > now && identitiesMatch(cached.identity, identity)) {
      this.remember(indexPath, cached, now)
      return cached.value
    }
    if (cached && cached.generation > generation) {
      // An older stat must not overwrite a generation cached by a newer concurrent read.
      return load(undefined)
    }

    const entry: KimiSessionIndexCacheEntry<T> = {
      expiresAt: now + KIMI_WORK_DIR_CACHE_TTL_MS,
      generation,
      identity,
      timer: null,
      value: load(cached?.value)
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

  private forget(indexPath: string, entry: KimiSessionIndexCacheEntry<T>): void {
    if (this.entries.get(indexPath) !== entry) {
      return
    }
    if (entry.timer) {
      clearTimeout(entry.timer)
    }
    this.entries.delete(indexPath)
  }

  private remember(indexPath: string, entry: KimiSessionIndexCacheEntry<T>, now: number): void {
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

function identitiesMatch(left: KimiSessionIndexIdentity, right: KimiSessionIndexIdentity): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.changeTimeMs === right.changeTimeMs &&
    left.mtimeMs === right.mtimeMs &&
    left.sizeBytes === right.sizeBytes
  )
}

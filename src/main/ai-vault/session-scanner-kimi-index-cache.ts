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
export const KIMI_WORK_DIR_CACHE_MAX_SESSIONS_PER_INDEX = 2_048
export const KIMI_WORK_DIR_CACHE_KEY_MAX_UTF8_BYTES = 32 * 1024
export const KIMI_WORK_DIR_SESSION_ID_MAX_UTF8_BYTES = 64 * 1024
export const KIMI_WORK_DIR_VALUE_MAX_UTF8_BYTES = 128 * 1024
export const KIMI_WORK_DIR_MAP_MAX_RETAINED_UTF8_BYTES = 512 * 1024
const KIMI_WORK_DIR_ENTRY_OVERHEAD_BYTES = 64
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
    const loadBounded = (): Promise<Map<string, string>> =>
      load().then((value) => boundKimiWorkDirMap(value))
    if (
      generation < this.minimumCacheGeneration ||
      Buffer.byteLength(indexPath, 'utf8') > KIMI_WORK_DIR_CACHE_KEY_MAX_UTF8_BYTES
    ) {
      return loadBounded()
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
      return loadBounded()
    }

    const entry: KimiSessionIndexCacheEntry = {
      expiresAt: now + KIMI_WORK_DIR_CACHE_TTL_MS,
      generation,
      identity,
      timer: null,
      value: loadBounded()
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

const retainedBytesByWorkDirMap = new WeakMap<Map<string, string>, number>()

export function retainKimiWorkDir(
  map: Map<string, string>,
  sessionId: string,
  workDir: string
): void {
  boundKimiWorkDirMap(map)
  const sessionIdBytes = Buffer.byteLength(sessionId, 'utf8')
  const workDirBytes = Buffer.byteLength(workDir, 'utf8')
  if (
    sessionIdBytes > KIMI_WORK_DIR_SESSION_ID_MAX_UTF8_BYTES ||
    workDirBytes > KIMI_WORK_DIR_VALUE_MAX_UTF8_BYTES
  ) {
    return
  }
  let retainedBytes = retainedBytesByWorkDirMap.get(map) ?? 0
  const existing = map.get(sessionId)
  if (existing !== undefined) {
    retainedBytes -= kimiWorkDirEntryBytes(sessionId, existing)
  }
  map.delete(sessionId)
  const entryBytes = sessionIdBytes + workDirBytes + KIMI_WORK_DIR_ENTRY_OVERHEAD_BYTES
  while (
    map.size >= KIMI_WORK_DIR_CACHE_MAX_SESSIONS_PER_INDEX ||
    retainedBytes + entryBytes > KIMI_WORK_DIR_MAP_MAX_RETAINED_UTF8_BYTES
  ) {
    const oldest = map.entries().next().value
    if (!oldest) {
      break
    }
    map.delete(oldest[0])
    retainedBytes -= kimiWorkDirEntryBytes(oldest[0], oldest[1])
  }
  map.set(sessionId, workDir)
  retainedBytesByWorkDirMap.set(map, retainedBytes + entryBytes)
}

function boundKimiWorkDirMap(map: Map<string, string>): Map<string, string> {
  if (retainedBytesByWorkDirMap.has(map)) {
    return map
  }
  const entries = [...map]
  map.clear()
  retainedBytesByWorkDirMap.set(map, 0)
  for (const [sessionId, workDir] of entries) {
    retainKimiWorkDir(map, sessionId, workDir)
  }
  return map
}

function kimiWorkDirEntryBytes(sessionId: string, workDir: string): number {
  return (
    Buffer.byteLength(sessionId, 'utf8') +
    Buffer.byteLength(workDir, 'utf8') +
    KIMI_WORK_DIR_ENTRY_OVERHEAD_BYTES
  )
}

function identitiesMatch(left: KimiSessionIndexIdentity, right: KimiSessionIndexIdentity): boolean {
  return (
    left.changeTimeMs === right.changeTimeMs &&
    left.mtimeMs === right.mtimeMs &&
    left.sizeBytes === right.sizeBytes
  )
}

import type { SessionParseCacheEntry } from './session-scanner-parse-cache'

// Sized past the default recency cap (1000) plus the in-scope cap (2000) so a
// full steady-state result set stays resident between forced rescans.
const MAX_CACHE_ENTRIES = 4096

const cache = new Map<string, SessionParseCacheEntry>()

export function resetSessionParseCacheForTests(): void {
  cache.clear()
}

// Drops one entry after its file is deleted. Cleanliness, not correctness:
// discovery walks disk first, so a trashed file is never rediscovered anyway.
export function invalidateSessionParseCacheEntry(path: string): void {
  cache.delete(path)
}

// Persisted subset of a cache entry: the non-serializable `resume` parser
// state is dropped (see session-parse-cache-persistence.ts).
export type PersistedSessionParseCacheEntry = Omit<SessionParseCacheEntry, 'resume'>

export function snapshotSessionParseCacheForPersistence(): [
  string,
  PersistedSessionParseCacheEntry
][] {
  return [...cache].map(([path, entry]): [string, PersistedSessionParseCacheEntry] => [
    path,
    {
      mtimeMs: entry.mtimeMs,
      sizeBytes: entry.sizeBytes,
      platform: entry.platform,
      session: entry.session
    }
  ])
}

// Seeded entries carry `resume: null`: after a restart an unchanged file is a
// cache hit; a file that changed while the app was closed pays one full
// (not incremental) re-parse.
export function seedSessionParseCache(
  entries: Iterable<[string, PersistedSessionParseCacheEntry]>
): void {
  const list = [...entries]
  // Snapshot order is oldest→newest (LRU); an over-cap list keeps the newest
  // tail rather than seeding the oldest entries and dropping the tail.
  for (const [path, entry] of list.slice(Math.max(0, list.length - MAX_CACHE_ENTRIES))) {
    if (cache.size >= MAX_CACHE_ENTRIES) {
      return
    }
    // In-process entries are always fresher than persisted ones; never clobber.
    if (cache.has(path)) {
      continue
    }
    cache.set(path, {
      mtimeMs: entry.mtimeMs,
      sizeBytes: entry.sizeBytes,
      platform: entry.platform,
      session: entry.session,
      resume: null
    })
  }
}

export function storeSessionParseCacheEntry(path: string, entry: SessionParseCacheEntry): void {
  cache.delete(path)
  cache.set(path, entry)
  if (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next()
    if (!oldest.done) {
      cache.delete(oldest.value)
    }
  }
}

export function getSessionParseCacheEntry(path: string): SessionParseCacheEntry | undefined {
  return cache.get(path)
}

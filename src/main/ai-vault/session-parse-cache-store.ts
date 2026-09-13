import type { AiVaultSession } from '../../shared/ai-vault-types'
import type { ResumableSessionParseState } from './session-scanner-types'
import type { SessionSidecarObservation } from './session-sidecar-stat'
import type { TranscriptMessageChannel } from './session-transcript-channel'

// Sized past the default recency cap (1000) plus the in-scope cap (2000) so a
// full steady-state result set stays resident between forced rescans.
const MAX_CACHE_ENTRIES = 4096

export type SessionParseResumePoint = {
  state: ResumableSessionParseState
  // Byte offset just past the last complete ('\n'-terminated) line consumed;
  // a trailing unterminated line is deliberately left before this point.
  byteOffset: number
  // Bound to the cached state, which keeps the reference its parsers were built
  // with; a resumed read re-points this channel instead of replacing it.
  channel: TranscriptMessageChannel
}

export type SessionParseCacheEntry = {
  mtimeMs: number
  sizeBytes: number | null
  platform: NodeJS.Platform
  session: AiVaultSession | null
  // What the sibling file looked like when `session` was built. Tracked apart
  // from the transcript's key so each can go stale on its own.
  sidecar?: SessionSidecarObservation
  // The session the transcript alone produced, before any sibling was merged
  // onto it. In-memory only: without it a sibling change costs one re-parse.
  foldSession?: AiVaultSession | null
  resume: SessionParseResumePoint | null
}

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
// state is dropped, and `foldSession` with it, so a restart pays one re-parse
// for a session whose sibling moved rather than storing every row twice
// (see session-parse-cache-persistence.ts).
export type PersistedSessionParseCacheEntry = Omit<SessionParseCacheEntry, 'resume' | 'foldSession'>

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
      session: entry.session,
      ...(entry.sidecar === undefined ? {} : { sidecar: entry.sidecar })
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
      // Absent in files an older build wrote; `sidecarUnchanged` reads that as
      // unknown, so such a row re-enriches on its first scan.
      sidecar: entry.sidecar,
      resume: null
    })
  }
}

export function getSessionParseCacheEntry(path: string): SessionParseCacheEntry | undefined {
  return cache.get(path)
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

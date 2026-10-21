import type { AiVaultSession } from '../../shared/ai-vault-types'
import type { ResumableSessionParseState } from './session-scanner-types'
import type { SessionSidecarObservation } from './session-sidecar-stat'
import type { TranscriptMessageChannel } from './session-transcript-channel'
import type { SkippedTranscriptRecord } from './session-transcript-record-budget'

// Rows Session History lists have no count bound: one smaller than an Unlimited
// scan evicts that scan's own upcoming hits (STA-10405), and each would cost a
// database lookup per scan. They live as long as this process. Rows only other
// readers created (search index, title lookups) keep a count bound, since an
// index build reads the whole corpus. Neither bound deletes persisted rows.
export const MAX_UNLISTED_ENTRIES = 4096
// Live parser state is the heavy part of a row and is count-bounded even on
// listed rows. Dropping it costs one whole re-read of a file that changed, never
// a re-parse of one that did not.
export const MAX_RESUME_ENTRIES = 4096

export type SessionParseResumePoint = {
  state: ResumableSessionParseState
  mtimeMs: number
  sizeBytes: number | undefined
  // Byte offset just past the last complete ('\n'-terminated) line consumed;
  // a trailing unterminated line is deliberately left before this point.
  byteOffset: number
  // Bound to the cached state, which keeps the reference its parsers were built
  // with; a resumed read re-points this channel instead of replacing it.
  channel: TranscriptMessageChannel
  // Records this fold dropped for exceeding the per-record budget, accumulated
  // across resumes. Lives with the fold, so a whole-file re-read starts clean.
  skippedRecords: SkippedTranscriptRecord[]
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
  // The dropped resume point's skipped records, so its notice outlives it.
  skippedRecords?: SkippedTranscriptRecord[]
}

// Persisted subset of a cache entry: the non-serializable parser state is
// dropped, and `foldSession` with it, so a restart pays one re-parse for a
// session whose sibling moved rather than storing every row twice.
export type PersistedSessionParseCacheEntry = Omit<
  SessionParseCacheEntry,
  'resume' | 'foldSession' | 'skippedRecords'
>

// A transcript version's cwd for scope membership: null means the version is
// known to have none, so no scope holds it.
export type SessionScopeCwdStamp = Pick<
  PersistedSessionParseCacheEntry,
  'mtimeMs' | 'sizeBytes' | 'platform' | 'sidecar'
> & { cwd: string | null }

// `parsed` (from a parse row) outranks `read` (learned without a parse).
export type SessionScopeCwdLookup = { parsed?: SessionScopeCwdStamp; read?: SessionScopeCwdStamp }
export type SessionScopeCwdRead = {
  found: Map<string, SessionScopeCwdLookup>
  parsed: boolean
  read: boolean
}

// The database behind this map (session-parse-cache-persistence.ts). A row the
// map's bounds drop is read back from it rather than re-parsed.
export type SessionParseCacheColdTier = {
  read(path: string): PersistedSessionParseCacheEntry | undefined
  stored(path: string, entry: PersistedSessionParseCacheEntry): void
  deleted(path: string): void
  readScopeCwds?(paths: readonly string[]): SessionScopeCwdRead
  storedScopeCwd?(path: string, stamp: SessionScopeCwdStamp): void
}

const cache = new Map<string, SessionParseCacheEntry>()
// Paths a History scan has listed. Kept apart from the rows so a forced whole
// re-read, which drops the row, leaves it listed.
const listedPaths = new Set<string>()
// Rows no History scan has listed, and rows holding a resume point: the two
// count-bounded sets.
const unlistedPaths = new Set<string>()
const resumePaths = new Set<string>()
// Scope cwds learned without a parse, for the paths the latest scope walk found.
const readScopeCwds = new Map<string, SessionScopeCwdStamp>()
const scopeKnowledge = new Map<string, SessionScopeCwdStamp | 'absent' | 'changed' | 'unresolved'>()
let coldTier: SessionParseCacheColdTier | null = null

export function setSessionParseCacheColdTier(next: SessionParseCacheColdTier | null): void {
  coldTier = next
  clearSessionScopeCwdKnowledge()
  readScopeCwds.clear()
}

export function clearSessionScopeCwdKnowledge(): void {
  scopeKnowledge.clear()
}

export function resetSessionParseCacheForTests(): void {
  cache.clear()
  listedPaths.clear()
  unlistedPaths.clear()
  resumePaths.clear()
  readScopeCwds.clear()
  clearSessionScopeCwdKnowledge()
  coldTier = null
}

// Drops one entry after its file is deleted, or to force a whole re-read. The
// cold tier drops it too, or the next lookup would read it back.
export function invalidateSessionParseCacheEntry(path: string): void {
  unlistedPaths.delete(path)
  resumePaths.delete(path)
  cache.delete(path)
  readScopeCwds.delete(path)
  scopeKnowledge.delete(path)
  coldTier?.deleted(path)
}

export function noteSessionParseCacheListed(path: string): void {
  listedPaths.add(path)
  unlistedPaths.delete(path)
}

export function getSessionParseCacheEntry(path: string): SessionParseCacheEntry | undefined {
  const entry = cache.get(path)
  if (entry !== undefined || coldTier === null || scopeKnowledge.get(path) === 'unresolved') {
    return entry
  }
  const persisted = coldTier.read(path)
  if (persisted === undefined) {
    return undefined
  }
  // A restart costs a file that changed one whole (not incremental) re-parse.
  const restored: SessionParseCacheEntry = { ...persisted, resume: null }
  placeRow(path, restored)
  return restored
}

/** A row's stored fields without placing it in memory: a scope walk checks thousands. */
export function peekSessionParseCacheEntry(
  path: string
): PersistedSessionParseCacheEntry | undefined {
  return (
    cache.get(path) ??
    (scopeKnowledge.get(path) === 'unresolved' ? undefined : coldTier?.read(path))
  )
}

/** Scope cwds for many paths at once: memory first, then one batched database read. */
export function lookupSessionScopeCwds(paths: readonly string[]): void {
  const cold = paths.filter((path) => !cache.has(path))
  const stored =
    coldTier === null || cold.length === 0
      ? { found: new Map<string, SessionScopeCwdLookup>(), parsed: true, read: true }
      : coldTier.readScopeCwds?.(cold)
  for (const path of paths) {
    const row = stored?.found.get(path)
    const parsed = row?.parsed ?? (stored?.parsed ? 'absent' : 'unresolved')
    scopeKnowledge.set(path, cache.has(path) ? 'changed' : parsed)
    const read = row?.read
    if (read && !readScopeCwds.has(path)) {
      readScopeCwds.set(path, read)
    }
  }
}

export function resolveSessionScopeCwd(
  path: string,
  matches: (stamp: SessionScopeCwdStamp) => boolean
): { cwd: string | null } | 'read' | 'parse' {
  const hot = cache.get(path)
  let parsed = hot ? scopeCwdStampOf(hot) : scopeKnowledge.get(path)
  if (parsed === 'changed') {
    const stored = coldTier?.readScopeCwds?.([path]).found.get(path)
    parsed = stored?.parsed ?? 'unresolved'
    scopeKnowledge.set(path, parsed)
    if (stored?.read && !readScopeCwds.has(path)) {
      readScopeCwds.set(path, stored.read)
    }
  }
  if (parsed === undefined || parsed === 'unresolved') {
    scopeKnowledge.set(path, 'unresolved')
    return 'parse'
  }
  for (const stamp of [typeof parsed === 'object' ? parsed : undefined, readScopeCwds.get(path)]) {
    if (stamp && matches(stamp)) {
      return { cwd: stamp.cwd }
    }
  }
  return 'read'
}

export function storeSessionScopeCwd(path: string, stamp: SessionScopeCwdStamp): void {
  readScopeCwds.set(path, stamp)
  coldTier?.storedScopeCwd?.(path, stamp)
}

/** Keeps in memory only the read cwds of transcripts the latest scope walk found. */
export function pruneSessionScopeCwds(discoveredPaths: ReadonlySet<string>): void {
  for (const map of [readScopeCwds, scopeKnowledge]) {
    for (const path of map.keys()) {
      if (!discoveredPaths.has(path)) {
        map.delete(path)
      }
    }
  }
}

export function scopeCwdStampOf(entry: PersistedSessionParseCacheEntry): SessionScopeCwdStamp {
  return {
    mtimeMs: entry.mtimeMs,
    sizeBytes: entry.sizeBytes,
    platform: entry.platform,
    cwd: entry.session?.cwd ?? null,
    ...(entry.sidecar === undefined ? {} : { sidecar: entry.sidecar })
  }
}

export function storeSessionParseCacheEntry(path: string, entry: SessionParseCacheEntry): void {
  if (scopeKnowledge.has(path)) {
    scopeKnowledge.set(path, 'changed')
  }
  const previous = cache.get(path)
  const changed =
    previous === undefined ||
    previous.mtimeMs !== entry.mtimeMs ||
    previous.sizeBytes !== entry.sizeBytes ||
    previous.platform !== entry.platform ||
    previous.session !== entry.session ||
    !sameSidecar(previous.sidecar, entry.sidecar)
  placeRow(path, entry)
  if (changed) {
    coldTier?.stored(path, {
      mtimeMs: entry.mtimeMs,
      sizeBytes: entry.sizeBytes,
      platform: entry.platform,
      session: entry.session,
      ...(entry.sidecar === undefined ? {} : { sidecar: entry.sidecar })
    })
  }
}

function placeRow(path: string, entry: SessionParseCacheEntry): void {
  cache.delete(path)
  cache.set(path, entry)
  resumePaths.delete(path)
  if (!listedPaths.has(path)) {
    unlistedPaths.add(path)
    trimOldestTranscripts(unlistedPaths, MAX_UNLISTED_ENTRIES, dropRow)
  }
  // Skipped when the trim above dropped this very row, so it can't cost others.
  if (entry.resume !== null && cache.has(path)) {
    resumePaths.add(path)
    trimOldestTranscripts(resumePaths, MAX_RESUME_ENTRIES, dropResumePoint)
  }
}

// Over the bound, drops the tenth whose transcripts were modified longest ago.
// Scans visit newest first, so store order would drop the most active files.
function trimOldestTranscripts(
  paths: Set<string>,
  max: number,
  drop: (path: string) => void
): void {
  if (paths.size <= max) {
    return
  }
  const oldest = [...paths]
    .sort((left, right) => (cache.get(left)?.mtimeMs ?? 0) - (cache.get(right)?.mtimeMs ?? 0))
    .slice(0, paths.size - max + Math.floor(max / 10))
  for (const path of oldest) {
    paths.delete(path)
    drop(path)
  }
}

function dropRow(path: string): void {
  resumePaths.delete(path)
  cache.delete(path)
}

function dropResumePoint(path: string): void {
  const entry = cache.get(path)
  if (entry?.resume) {
    // Same key, so the row keeps its place in the map.
    cache.set(path, { ...entry, resume: null, skippedRecords: entry.resume.skippedRecords })
  }
}

function sameSidecar(
  left: SessionSidecarObservation | undefined,
  right: SessionSidecarObservation | undefined
): boolean {
  return (
    left === right ||
    (typeof left === 'object' &&
      typeof right === 'object' &&
      left.path === right.path &&
      left.mtimeMs === right.mtimeMs &&
      left.sizeBytes === right.sizeBytes)
  )
}

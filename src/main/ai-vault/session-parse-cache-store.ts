import type { Hash } from 'node:crypto'
import type { AiVaultAgent, AiVaultSession } from '../../shared/ai-vault-types'
import type { ResumableSessionParseState } from './session-scanner-types'
import type { SessionSidecarObservation } from './session-sidecar-stat'
import type { TranscriptMessageChannel } from './session-transcript-channel'
import type { SkippedTranscriptRecord } from './session-transcript-record-budget'

// Keep listed rows hot: unlimited scans must not evict their own next hits; only unlisted rows are count-bounded.
export const MAX_UNLISTED_ENTRIES = 4096
// Dropping heavy parser state rereads only changed files; persisted session rows survive.
export const MAX_RESUME_ENTRIES = 4096

export type SessionParseResumePoint = {
  state: ResumableSessionParseState
  mtimeMs: number
  sizeBytes: number | undefined
  // Resume after the last terminated line; leave partial trailing records unread.
  byteOffset: number
  // Cached parsers retain this channel reference; resume repoints it rather than replacing it.
  channel: TranscriptMessageChannel
  // Accumulate budget skips across resumes; full reparsing starts a new list.
  skippedRecords: SkippedTranscriptRecord[]
  // Hash of bytes before byteOffset; null when the read that set this point did not hash.
  prefixHash: Hash | null
}

export type SessionParseCacheEntry = {
  mtimeMs: number
  sizeBytes: number | null
  platform: NodeJS.Platform
  session: AiVaultSession | null
  // Sidecar and transcript versions can become stale independently.
  sidecar?: SessionSidecarObservation
  // Retain the transcript-only result so sidecar changes do not force a reparse.
  foldSession?: AiVaultSession | null
  resume: SessionParseResumePoint | null
  // Keep skipped-record notices after incremental parser state is dropped.
  skippedRecords?: SkippedTranscriptRecord[]
  // Parser identity is runtime-only; persisted sessions carry their agent.
  agent?: AiVaultAgent
}

// Omit parser state and duplicate fold results; sibling changes after restart pay one reparse.
export type PersistedSessionParseCacheEntry = Omit<
  SessionParseCacheEntry,
  'resume' | 'foldSession' | 'skippedRecords' | 'agent'
>

// Null proves this transcript version belongs to no scoped path.
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

// Evicted hot rows reload from this tier instead of reparsing transcripts.
export type SessionParseCacheColdTier = {
  read(path: string): PersistedSessionParseCacheEntry | undefined
  stored(path: string, entry: PersistedSessionParseCacheEntry): void
  deleted(path: string): void
  readScopeCwds?(paths: readonly string[]): SessionScopeCwdRead
  storedScopeCwd?(path: string, stamp: SessionScopeCwdStamp): void
}

const cache = new Map<string, SessionParseCacheEntry>()
// Track listing separately so forced reparsing does not make a listed path unlisted.
const listedPaths = new Set<string>()
const unlistedPaths = new Set<string>()
const resumePaths = new Set<string>()
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

// Pi and OMP can share roots; retain separate parser-specific rows for the same transcript.
const SHARED_TRANSCRIPT_AGENTS: ReadonlySet<string> = new Set<AiVaultAgent>(['pi', 'omp'])

export function sessionParseCacheKey(agent: AiVaultAgent, path: string): string {
  if (!SHARED_TRANSCRIPT_AGENTS.has(agent)) {
    return path
  }
  // Resolve listing identity without placing the row into the hot cache.
  const hot = cache.get(path)
  const owner = hot?.agent ?? (hot ?? peekSessionParseCacheEntry(path))?.session?.agent
  return owner === undefined || owner === agent ? path : `${path}#${agent}`
}

export function sessionParseCacheTranscriptPath(key: string): string {
  const agent = key.slice(key.lastIndexOf('#') + 1)
  return SHARED_TRANSCRIPT_AGENTS.has(agent) ? key.slice(0, -agent.length - 1) : key
}

// Invalidate both tiers so later lookups cannot resurrect deleted or forcibly reparsed rows.
export function invalidateSessionParseCacheEntry(path: string): void {
  for (const key of [path, ...[...SHARED_TRANSCRIPT_AGENTS].map((agent) => `${path}#${agent}`)]) {
    unlistedPaths.delete(key)
    resumePaths.delete(key)
    cache.delete(key)
    readScopeCwds.delete(key)
    scopeKnowledge.delete(key)
    coldTier?.deleted(key)
  }
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
  // Parser state is runtime-only; changed files need a full parse after restart.
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
  // A row evicted above must not consume other rows' resume budget.
  if (entry.resume !== null && cache.has(path)) {
    resumePaths.add(path)
    trimOldestTranscripts(resumePaths, MAX_RESUME_ENTRIES, dropResumePoint)
  }
}

// Evict by transcript age: newest-first scan insertion order would discard the most active files.
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

// Persists the reusable portion of the AI Vault session parse cache to one
// JSON file under userData so a fresh launch reuses prior parse work instead
// of re-reading the whole transcript corpus (issue #9210: 6.7 GB / 109 s cold
// scans). Disabled unless the composition root calls init; every failure mode
// degrades to today's cold-scan behavior.
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { readNodeFileWithinLimit } from '../../shared/node-bounded-file-reader'
import { readStreamedSessionDocument } from './session-document-stream'
import { MAX_CACHE_ENTRIES } from './session-parse-cache-store'
import {
  assertSessionParseCacheJsonWithinLimitsCooperatively,
  serializeSessionParseCacheSnapshotPiecesCooperatively,
  SESSION_PARSE_CACHE_SCHEMA_VERSION,
  SESSION_PARSE_CACHE_MAX_BYTES
} from './session-parse-cache-snapshot-serialization'
import {
  seedSessionParseCache,
  snapshotSessionParseCacheForPersistence,
  type PersistedSessionParseCacheEntry,
  type SessionParseStats
} from './session-scanner-parse-cache'
import type { SessionSidecarObservation } from './session-sidecar-stat'

// Bump when the persisted entry layout or cached session semantics change; a
// mismatched file is discarded whole.
const SCHEMA_VERSION = SESSION_PARSE_CACHE_SCHEMA_VERSION
// Debounce so back-to-back scans (desktop IPC + runtime RPC) collapse into one write.
const SAVE_DEBOUNCE_MS = 1_500
// The payload contains transcript-derived preview text; keep it user-only
// (mode bits are inert on Windows — the userData ACL grant is the boundary there).
const PRIVATE_DIRECTORY_MODE = 0o700
const PRIVATE_FILE_MODE = 0o600

export type SessionParseCachePersistenceOptions = {
  filePath: string
  appVersion: string
}

let options: SessionParseCachePersistenceOptions | null = null
let loadPromise: Promise<void> | null = null
let saveTimer: NodeJS.Timeout | null = null
let lastSave: Promise<void> = Promise.resolve()

/** Enable persistence. Called only from the composition root; every export is a no-op until then. */
export function initSessionParseCachePersistence(next: SessionParseCachePersistenceOptions): void {
  options = next
}

export function getSessionParseCachePersistenceOptions(): SessionParseCachePersistenceOptions | null {
  return options ? { ...options } : null
}

export function resetSessionParseCachePersistenceForTests(): void {
  options = null
  loadPromise = null
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  lastSave = Promise.resolve()
}

/**
 * Seed the in-memory parse cache from disk. Memoized: concurrent scans at
 * startup all await the same load. Resolves immediately when uninitialized.
 */
export function ensureSessionParseCacheLoaded(): Promise<void> {
  if (options === null) {
    return Promise.resolve()
  }
  loadPromise ??= loadPersistedEntries(options)
  return loadPromise
}

/**
 * Schedule a debounced snapshot write after a scan that parsed something. An
 * early-stopped transcript counts: its stat key moved, so the entry must be
 * re-persisted or the next launch re-reads it. Reused-only scans schedule no
 * write (the file already reflects the cache).
 */
export function scheduleSessionParseCachePersist(stats: SessionParseStats): void {
  if (options === null || stats.incremental + stats.fullParses + stats.earlyStopped <= 0) {
    return
  }
  const current = options
  if (saveTimer) {
    clearTimeout(saveTimer)
  }
  saveTimer = setTimeout(() => {
    saveTimer = null
    // Chained so a slow write and a rescheduled save can't rename out of order
    // (an older snapshot landing last); persistSnapshot never rejects.
    lastSave = lastSave.then(() => persistSnapshot(current))
  }, SAVE_DEBOUNCE_MS)
  // Why: a pending cache save must not keep a quitting process alive.
  if (typeof saveTimer.unref === 'function') {
    saveTimer.unref()
  }
}

/** Run any pending debounced save immediately and wait for it before process exit. */
export async function flushSessionParseCachePersist(): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
    if (options !== null) {
      const current = options
      lastSave = lastSave.then(() => persistSnapshot(current))
    }
  }
  await lastSave
}

export const flushSessionParseCachePersistForTests = flushSessionParseCachePersist

async function loadPersistedEntries(current: SessionParseCachePersistenceOptions): Promise<void> {
  await sweepOrphanedTempFiles(current.filePath)
  try {
    const { buffer } = await readNodeFileWithinLimit(
      current.filePath,
      SESSION_PARSE_CACHE_MAX_BYTES
    )
    await assertSessionParseCacheJsonWithinLimitsCooperatively(buffer)
    const entries = await parsePersistedFile(buffer)
    if (entries) {
      seedSessionParseCache(entries)
    }
  } catch {
    // Why: a missing/corrupt/foreign cache file must never fail the scan;
    // worst case is exactly today's cold scan.
  }
}

// A death between temp-write and rename orphans a uniquely named .tmp forever;
// sweep once per launch so they can't accumulate. Racing another instance's
// in-flight save at worst loses that save — the already-accepted rename trade.
async function sweepOrphanedTempFiles(filePath: string): Promise<void> {
  const directory = dirname(filePath)
  try {
    const names = await readdir(directory)
    await Promise.all(
      names
        .filter((name) => name.startsWith('session-parse-cache-') && name.endsWith('.tmp'))
        .map((name) => rm(join(directory, name), { force: true }).catch(() => {}))
    )
  } catch {
    // Directory missing or unreadable — nothing to sweep.
  }
}

async function parsePersistedFile(
  buffer: Buffer
): Promise<[string, PersistedSessionParseCacheEntry][] | null> {
  const parsed = await readStreamedSessionDocument({
    bytes: cacheFileChunks(buffer),
    arrayKey: 'entries',
    fields: ['schemaVersion', 'appVersion'],
    create: () => new Map<string, PersistedSessionParseCacheEntry>(),
    consume(entries, item) {
      const entry = parsePersistedEntry(item)
      if (entry === null) {
        throw new Error('Malformed session parse cache row')
      }
      entries.delete(entry[0])
      entries.set(entry[0], entry[1])
      if (entries.size > MAX_CACHE_ENTRIES) {
        const oldest = entries.keys().next()
        if (!oldest.done) {
          entries.delete(oldest.value)
        }
      }
    }
  })
  // Why: application releases that keep this schema promise compatible cached
  // session semantics, so an update does not force a multi-gigabyte cold scan.
  if (
    parsed?.record.schemaVersion !== SCHEMA_VERSION ||
    typeof parsed.record.appVersion !== 'string'
  ) {
    return null
  }
  return [...parsed.state]
}

async function* cacheFileChunks(buffer: Buffer): AsyncGenerator<Buffer> {
  for (let start = 0; start < buffer.length; start += 64 * 1024) {
    yield buffer.subarray(start, start + 64 * 1024)
  }
}

function parsePersistedEntry(item: unknown): [string, PersistedSessionParseCacheEntry] | null {
  if (!Array.isArray(item) || item.length !== 2) {
    return null
  }
  const [path, value] = item as [unknown, unknown]
  if (typeof path !== 'string' || typeof value !== 'object' || value === null) {
    return null
  }
  const entry = value as Record<string, unknown>
  if (typeof entry.mtimeMs !== 'number') {
    return null
  }
  if (entry.sizeBytes !== null && typeof entry.sizeBytes !== 'number') {
    return null
  }
  if (typeof entry.platform !== 'string') {
    return null
  }
  if (entry.session !== null && typeof entry.session !== 'object') {
    return null
  }
  const sidecar = parsePersistedSidecar(entry.sidecar)
  return [
    path,
    {
      mtimeMs: entry.mtimeMs,
      sizeBytes: entry.sizeBytes,
      platform: entry.platform as NodeJS.Platform,
      session: entry.session as PersistedSessionParseCacheEntry['session'],
      ...(sidecar === undefined ? {} : { sidecar })
    }
  ]
}

// Why: added after SCHEMA_VERSION 2 shipped, so a file an older build wrote has
// no such field. Absent (or unreadable) means unknown, which costs one re-parse
// of the rows that have a sibling and nothing at all for the rest.
function parsePersistedSidecar(value: unknown): SessionSidecarObservation | undefined {
  if (value === 'none' || value === 'unknown') {
    return value
  }
  if (typeof value !== 'object' || value === null) {
    return undefined
  }
  const record = value as Record<string, unknown>
  return typeof record.path === 'string' &&
    typeof record.mtimeMs === 'number' &&
    typeof record.sizeBytes === 'number'
    ? { path: record.path, mtimeMs: record.mtimeMs, sizeBytes: record.sizeBytes }
    : undefined
}

async function persistSnapshot(current: SessionParseCachePersistenceOptions): Promise<void> {
  const directory = dirname(current.filePath)
  const tempPath = join(directory, `session-parse-cache-${process.pid}-${Date.now()}.tmp`)
  try {
    const payload = await serializeSessionParseCacheSnapshotPiecesCooperatively(
      snapshotSessionParseCacheForPersistence(),
      current.appVersion
    )
    if (payload === null) {
      return
    }
    await mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE })
    await writeFile(tempPath, payload.pieces, { mode: PRIVATE_FILE_MODE })
    // Atomic on POSIX; on Windows a rename racing an open handle fails and is
    // caught below (save lost, never a torn file).
    await rename(tempPath, current.filePath)
  } catch (err) {
    // Why: the save runs from a timer — every error must be swallowed here or
    // it becomes an unhandled rejection. Worst case is the no-file case.
    await rm(tempPath, { force: true }).catch(() => {})
    console.debug('[ai-vault] session parse cache save failed', err)
  }
}

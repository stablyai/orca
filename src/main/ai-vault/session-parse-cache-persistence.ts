// Scanner-owned SQLite rows back the hot cache; failures fall back to transcript parsing (#9210).
import { stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import { splitOpenCodeSqliteCandidate } from '../../shared/opencode-sqlite-session-path'
import { SessionParseCacheDatabase } from './session-parse-cache-database'
import { importLegacySessionParseCacheJson } from './session-parse-cache-legacy-json'
import {
  scopeCwdStampOf,
  sessionParseCacheTranscriptPath,
  setSessionParseCacheColdTier,
  type PersistedSessionParseCacheEntry,
  type SessionScopeCwdRead,
  type SessionScopeCwdStamp
} from './session-parse-cache-store'

const WRITE_DEBOUNCE_MS = 1_500
const WRITE_MAX_WAIT_MS = 15_000
const WRITE_CHUNK_ROWS = 500
// Recheck inactive native rows for missing transcripts; inactivity alone does not evict them.
const RECHECK_AFTER_MS = 30 * 24 * 60 * 60_000
// Bound cleanup work per scanner start.
const RECHECK_BATCH_ROWS = 1_000
// Never stat WSL rows: stopped distros can boot or hang; expire unused rows after 180 days instead.
const WSL_PATH_GLOB = '[\\/][\\/][wW][sS][lL][.$]*'
const WSL_EXPIRE_AFTER_MS = 180 * 24 * 60 * 60_000
const SQLITE_SESSION_AGENTS = ['opencode', 'opencode2', 'zcode'] as const

export type SessionParseCachePersistenceOptions = {
  // The legacy JSON file; the database sits beside it.
  filePath: string
  appVersion: string
}

let options: SessionParseCachePersistenceOptions | null = null
let owner = false
// Undefined is unopened; null disables persistence for this process.
let database: SessionParseCacheDatabase | null | undefined
const pendingWrites = new Map<string, PersistedSessionParseCacheEntry>()
const pendingScopeCwds = new Map<string, SessionScopeCwdStamp>()
let writeTimer: NodeJS.Timeout | null = null
let pendingSince: number | null = null

/** Main passes cache options to the scanner child without opening the database. */
export function configureSessionParseCachePersistence(
  next: SessionParseCachePersistenceOptions
): void {
  options = { ...next }
}

/** Only the scanner child owns database read-through and write-back. */
export function initSessionParseCachePersistence(next: SessionParseCachePersistenceOptions): void {
  configureSessionParseCachePersistence(next)
  owner = true
  setSessionParseCacheColdTier({
    read: readRow,
    stored: queueWrite,
    deleted: deleteRow,
    readScopeCwds,
    storedScopeCwd: queueScopeCwdWrite
  })
}

export function getSessionParseCachePersistenceOptions(): SessionParseCachePersistenceOptions | null {
  return options ? { ...options } : null
}

export function resetSessionParseCachePersistenceForTests(): void {
  clearWriteTimer()
  pendingWrites.clear()
  pendingScopeCwds.clear()
  database?.close()
  database = undefined
  options = null
  owner = false
  setSessionParseCacheColdTier(null)
}

/** Flush queued chunks before exit instead of waiting for debounce. */
export async function flushSessionParseCachePersist(): Promise<void> {
  clearWriteTimer()
  while (pendingWrites.size > 0) {
    const chunk = takeWriteChunk(pendingWrites)
    openedDatabase()?.write(chunk, Date.now())
    if (pendingWrites.size > 0) {
      await yieldToEventLoop()
    }
  }
  while (pendingScopeCwds.size > 0) {
    const chunk = takeWriteChunk(pendingScopeCwds)
    openedDatabase()?.writeScopeCwds(chunk, Date.now())
    if (pendingScopeCwds.size > 0) {
      await yieldToEventLoop()
    }
  }
}

function takeWriteChunk<T>(pending: Map<string, T>): [string, T][] {
  const chunk: [string, T][] = []
  for (const row of pending) {
    chunk.push(row)
    pending.delete(row[0])
    if (chunk.length === WRITE_CHUNK_ROWS) {
      break
    }
  }
  return chunk
}

function openedDatabase(): SessionParseCacheDatabase | null {
  if (database !== undefined || !owner || options === null) {
    return database ?? null
  }
  try {
    database = new SessionParseCacheDatabase(
      join(dirname(options.filePath), 'session-parse-cache.sqlite')
    )
    importLegacySessionParseCacheJson(options.filePath, database, Date.now())
    void dropRowsForMissingTranscripts(database)
  } catch (error) {
    console.debug('[ai-vault] session parse cache database unavailable', error)
    database = null
  }
  return database
}

// Native expiry needs filesystem absence; WSL rows instead use age to avoid probing distros.
async function dropRowsForMissingTranscripts(db: SessionParseCacheDatabase): Promise<void> {
  let dropped = db.deleteSeenBefore(Date.now() - WSL_EXPIRE_AFTER_MS, WSL_PATH_GLOB)
  const stale = db.pathsSeenBefore(Date.now() - RECHECK_AFTER_MS, RECHECK_BATCH_ROWS, WSL_PATH_GLOB)
  for (const path of stale) {
    if (await transcriptMissing(sessionParseCacheTranscriptPath(path))) {
      db.delete(path)
      dropped = true
    } else {
      db.markSeen(path, Date.now())
    }
  }
  if (dropped) {
    db.reclaimSpace()
  }
}

// Synthetic db#session keys use the database file as the transcript for existence checks.
async function transcriptMissing(path: string): Promise<boolean> {
  const sqliteSession = SQLITE_SESSION_AGENTS.map((agent) =>
    splitOpenCodeSqliteCandidate(path, agent)
  ).find((split) => split !== null)
  return (await pathMissing(path)) && (!sqliteSession || (await pathMissing(sqliteSession.dbPath)))
}

// Permission failures and slow mounts do not prove absence.
async function pathMissing(path: string): Promise<boolean> {
  try {
    await stat(path)
    return false
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined
    return code === 'ENOENT' || code === 'ENOTDIR'
  }
}

function readRow(path: string): PersistedSessionParseCacheEntry | undefined {
  return pendingWrites.get(path) ?? openedDatabase()?.read(path)
}

function readScopeCwds(paths: readonly string[]): SessionScopeCwdRead {
  const result: SessionScopeCwdRead = openedDatabase()?.readScopeCwds(paths) ?? {
    found: new Map(),
    parsed: false,
    read: false
  }
  const found = result.found
  for (const path of paths) {
    const row = pendingWrites.get(path)
    const read = pendingScopeCwds.get(path)
    if (row !== undefined || read !== undefined) {
      found.set(path, {
        ...found.get(path),
        ...(row === undefined ? {} : { parsed: scopeCwdStampOf(row) }),
        ...(read === undefined ? {} : { read })
      })
    }
  }
  return result
}

function queueScopeCwdWrite(path: string, stamp: SessionScopeCwdStamp): void {
  pendingScopeCwds.delete(path)
  pendingScopeCwds.set(path, stamp)
  scheduleFlush()
}

function queueWrite(path: string, entry: PersistedSessionParseCacheEntry): void {
  pendingWrites.delete(path)
  pendingWrites.set(path, entry)
  scheduleFlush()
}

function scheduleFlush(): void {
  const now = Date.now()
  pendingSince ??= now
  if (writeTimer) {
    clearTimeout(writeTimer)
  }
  writeTimer = setTimeout(
    () => void flushSessionParseCachePersist(),
    Math.max(0, Math.min(WRITE_DEBOUNCE_MS, pendingSince + WRITE_MAX_WAIT_MS - now))
  )
  writeTimer.unref?.()
}

// Delete immediately so queued writes and later cold lookups cannot resurrect the row.
function deleteRow(path: string): void {
  pendingWrites.delete(path)
  pendingScopeCwds.delete(path)
  openedDatabase()?.delete(path)
}

function clearWriteTimer(): void {
  if (writeTimer) {
    clearTimeout(writeTimer)
    writeTimer = null
  }
  pendingSince = null
}

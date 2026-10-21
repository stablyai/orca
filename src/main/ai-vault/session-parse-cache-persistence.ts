// Persists the reusable portion of the AI Vault session parse cache, one SQLite
// row per transcript, so a fresh launch reuses prior parse work instead of
// re-reading the whole transcript corpus (issue #9210: 6.7 GB / 109 s cold
// scans). The in-memory map is the hot tier; the database is read on a miss and
// written only with what changed. Only the scanner child opens it, and every
// failure degrades to a re-parse.
import { stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import { splitOpenCodeSqliteCandidate } from '../../shared/opencode-sqlite-session-path'
import { SessionParseCacheDatabase } from './session-parse-cache-database'
import { importLegacySessionParseCacheJson } from './session-parse-cache-legacy-json'
import {
  scopeCwdStampOf,
  setSessionParseCacheColdTier,
  type PersistedSessionParseCacheEntry,
  type SessionScopeCwdRead,
  type SessionScopeCwdStamp
} from './session-parse-cache-store'

const WRITE_DEBOUNCE_MS = 1_500
const WRITE_MAX_WAIT_MS = 15_000
const WRITE_CHUNK_ROWS = 500
// How long a row goes unparsed before its transcript is checked for on disk.
// Only a missing transcript ends a row, so time away never empties the cache.
const RECHECK_AFTER_MS = 30 * 24 * 60 * 60_000
// Per helper start; it restarts often enough to work through a large backlog.
const RECHECK_BATCH_ROWS = 1_000
// WSL transcripts (`\\wsl.localhost\…`, `\\wsl$\…`) are never stat-checked here:
// that could boot a stopped distro or hang on a stuck one outside the scanner's
// running-distro filter. Their rows age out instead, after half a year unparsed.
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
// undefined: not opened yet; null: unavailable for this process's life.
let database: SessionParseCacheDatabase | null | undefined
const pendingWrites = new Map<string, PersistedSessionParseCacheEntry>()
const pendingScopeCwds = new Map<string, SessionScopeCwdStamp>()
let writeTimer: NodeJS.Timeout | null = null
let pendingSince: number | null = null

/** Electron main records where the cache lives for the scanner child it spawns; it never opens it. */
export function configureSessionParseCachePersistence(
  next: SessionParseCachePersistenceOptions
): void {
  options = { ...next }
}

/** The scanner child's half: lookups read through to the database and changes are written back. */
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

/** Write every queued row now, before process exit. Each committed chunk survives a kill. */
export async function flushSessionParseCachePersist(): Promise<void> {
  clearWriteTimer()
  while (pendingWrites.size > 0) {
    const chunk: [string, PersistedSessionParseCacheEntry][] = []
    for (const row of pendingWrites) {
      chunk.push(row)
      pendingWrites.delete(row[0])
      if (chunk.length === WRITE_CHUNK_ROWS) {
        break
      }
    }
    openedDatabase()?.write(chunk, Date.now())
    if (pendingWrites.size > 0) {
      await yieldToEventLoop()
    }
  }
  while (pendingScopeCwds.size > 0) {
    const chunk = [...pendingScopeCwds].slice(0, WRITE_CHUNK_ROWS)
    for (const [path] of chunk) {
      pendingScopeCwds.delete(path)
    }
    openedDatabase()?.writeScopeCwds(chunk, Date.now())
    if (pendingScopeCwds.size > 0) {
      await yieldToEventLoop()
    }
  }
}

// Opened on first need, so Electron main (which never looks rows up) never opens it.
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

// A row for a transcript deleted outside Orca is never looked up again, so the
// file system, not a timer, decides when it ends.
async function dropRowsForMissingTranscripts(db: SessionParseCacheDatabase): Promise<void> {
  let dropped = db.deleteSeenBefore(Date.now() - WSL_EXPIRE_AFTER_MS, WSL_PATH_GLOB)
  const stale = db.pathsSeenBefore(Date.now() - RECHECK_AFTER_MS, RECHECK_BATCH_ROWS, WSL_PATH_GLOB)
  for (const path of stale) {
    if (await transcriptMissing(path)) {
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

// SQLite-backed sessions (OpenCode and its forks) are keyed `<db>#<id>`, so for
// those the database file stands in for the transcript.
async function transcriptMissing(path: string): Promise<boolean> {
  const sqliteSession = SQLITE_SESSION_AGENTS.map((agent) =>
    splitOpenCodeSqliteCandidate(path, agent)
  ).find((split) => split !== null)
  return (await pathMissing(path)) && (!sqliteSession || (await pathMissing(sqliteSession.dbPath)))
}

// Unreachable (a permission error, a slow mount) is not missing.
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

// Immediate, so a queued write or a later lookup can't bring the row back.
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

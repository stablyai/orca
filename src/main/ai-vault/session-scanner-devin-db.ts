import { dirname, join } from 'node:path'
import { wslGatedStat } from '../native-chat/wsl-transcript-fs-access'
import { columnExists, tableExists } from '../opencode-usage/schema-helpers'
import { readOpenCodeDatabase } from './session-scanner-opencode-sqlite-open'
import type { SessionSidecarObservation } from './session-sidecar-stat'
import { asRecord } from './session-scanner-record-value'
import { numberValue } from './session-scanner-token-values'
import { extractString } from './session-scanner-values'

// Why: Devin CLI keeps a tiny `sessions` table in sessions.db beside the
// transcripts dir — the transcript holds no cwd on Windows installs, so the db
// is what lets a Devin session group under a workspace. One row per session_id
// (the transcript filename), timestamps in unix SECONDS.

export type DevinSessionIndexRow = {
  workingDirectory: string | null
  title: string | null
  model: string | null
  createdAt: string | null
  lastActivityAt: string | null
  // The user hid the session in Devin's own UI; the listing honors that.
  hidden: boolean
}

export type DevinSessionsIndex = Map<string, DevinSessionIndexRow>

// Optional in older schemas; `id` is the only required column.
const DEVIN_SESSION_TABLE = 'sessions'
const DEVIN_SESSION_OPTIONAL_COLUMNS = [
  'working_directory',
  'title',
  'model',
  'created_at',
  'last_activity_at',
  'hidden'
] as const

// One index per observed db stat, so all transcripts under a root share a
// single open per scan and a db the transcript mtimes cannot see still
// re-merges when its own stat moves.
const INDEX_CACHE_LIMIT = 8
const indexCache = new Map<
  string,
  { mtimeMs: number; sizeBytes: number; index: DevinSessionsIndex }
>()

/**
 * The sessions.db a transcript's index lives in: it sits beside the
 * transcripts dir, never inside it. Transcripts are flat files directly under
 * the root, so the db is always dirname(dirname(file)).
 * @param transcriptFilePath - A discovered Devin transcript path.
 * @returns Absolute path to the sibling sessions.db.
 */
export function devinSessionsDbPath(transcriptFilePath: string): string {
  return join(dirname(dirname(transcriptFilePath)), 'sessions.db')
}

/**
 * The file whose stat should drive re-enrichment. In WAL mode, committed rows
 * sit in sessions.db-wal while sessions.db keeps its stat until checkpoint, so
 * a present wal is the fresher signal; a clean-close db has no wal and its own
 * stat carries the change.
 * @param transcriptFilePath - A discovered Devin transcript path.
 * @returns Absolute path to sessions.db-wal when it exists, else sessions.db.
 */
export async function devinSessionsDbDependencyPath(transcriptFilePath: string): Promise<string> {
  const dbPath = devinSessionsDbPath(transcriptFilePath)
  const walPath = `${dbPath}-wal`
  try {
    await wslGatedStat(walPath, 'scan')
    return walPath
  } catch {
    // Missing wal is the common case; a refused probe degrades to watching
    // the db itself rather than taking the transcript down with it.
    return dbPath
  }
}

/**
 * The db a dependency observation actually belongs to: the sidecar may point
 * at sessions.db-wal, but SQLite is always opened on sessions.db itself.
 */
function devinSessionsDbPathForSidecarPath(sidecarPath: string): string {
  return sidecarPath.endsWith('-wal') ? sidecarPath.slice(0, -'-wal'.length) : sidecarPath
}

/**
 * The sessions.db index for a discovery-observed sidecar, or why there is
 * none. Never throws: a missing/db-less root is `index: null`, an observed db
 * that could not be read is `unreadable` (so the caller records the sidecar as
 * unknown and retries next scan rather than caching un-enriched results).
 * @param sidecar - The file's sidecar observation from discovery.
 */
export function devinSessionsIndexForSidecar(sidecar: SessionSidecarObservation | undefined): {
  index: DevinSessionsIndex | null
  unreadable: boolean
} {
  if (sidecar === undefined || sidecar === 'none') {
    return { index: null, unreadable: false }
  }
  if (sidecar === 'unknown') {
    // The stat already failed this scan; an open would ride the same stalled
    // share. Retry next scan instead of paying it per transcript.
    return { index: null, unreadable: true }
  }
  const dbPath = devinSessionsDbPathForSidecarPath(sidecar.path)
  const cached = indexCache.get(dbPath)
  if (cached && cached.mtimeMs === sidecar.mtimeMs && cached.sizeBytes === sidecar.sizeBytes) {
    indexCache.delete(dbPath)
    indexCache.set(dbPath, cached)
    return { index: cached.index, unreadable: false }
  }
  try {
    const index = readDevinSessionsIndex(dbPath)
    if (indexCache.size >= INDEX_CACHE_LIMIT) {
      const oldest = indexCache.keys().next().value
      if (oldest !== undefined) {
        indexCache.delete(oldest)
      }
    }
    indexCache.set(dbPath, {
      mtimeMs: sidecar.mtimeMs,
      sizeBytes: sidecar.sizeBytes,
      index
    })
    return { index, unreadable: false }
  } catch {
    // Deliberately uncached: contention is transient, and caching a failure
    // under an unchanged stat would refuse enrichment until the db moved.
    return { index: null, unreadable: true }
  }
}

export function resetDevinSessionsIndexCacheForTests(): void {
  indexCache.clear()
}

/**
 * Read every session row from a Devin sessions.db. Read-only plus query_only,
 * same open policy as the OpenCode db (which also picks the busy timeout: 0
 * over a WSL share, where SQLite locks can never be taken). Older schemas
 * missing optional columns still yield rows; a db without the sessions table
 * or its id column yields an empty index.
 * @param dbPath - Absolute path to a sessions.db file.
 * @returns Rows keyed by session id; rethrows whatever SQLite raised.
 */
function readDevinSessionsIndex(dbPath: string): DevinSessionsIndex {
  return readOpenCodeDatabase({
    dbPath,
    read: (db) => {
      const index: DevinSessionsIndex = new Map()
      if (!tableExists(db, DEVIN_SESSION_TABLE) || !columnExists(db, DEVIN_SESSION_TABLE, 'id')) {
        return index
      }
      const columns = DEVIN_SESSION_OPTIONAL_COLUMNS.filter((column) =>
        columnExists(db, DEVIN_SESSION_TABLE, column)
      )
      const statement = db.prepare(
        `SELECT id${columns.map((column) => `, ${column}`).join('')} FROM ${DEVIN_SESSION_TABLE}`
      )
      for (const row of statement.all()) {
        const record = asRecord(row)
        const id = record ? extractString(record.id) : null
        if (!record || !id) {
          continue
        }
        index.set(id, {
          workingDirectory: extractString(record.working_directory),
          title: extractString(record.title),
          model: extractString(record.model),
          createdAt: unixSecondsToIso(record.created_at),
          lastActivityAt: unixSecondsToIso(record.last_activity_at),
          hidden: numberValue(record.hidden) !== 0
        })
      }
      return index
    }
  })
}

function unixSecondsToIso(value: unknown): string | null {
  const seconds = numberValue(value)
  if (seconds <= 0) {
    return null
  }
  const date = new Date(seconds * 1000)
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}

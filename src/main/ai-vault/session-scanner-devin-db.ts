import { AsyncLocalStorage } from 'node:async_hooks'
import { dirname, join } from 'node:path'
import { wslGatedStat } from '../native-chat/wsl-transcript-fs-access'
import { columnExists, tableExists } from '../opencode-usage/schema-helpers'
import { readOpenCodeDatabase } from './session-scanner-opencode-sqlite-open'
import type { SessionSidecarObservation } from './session-sidecar-stat'
import { asRecord } from './session-scanner-record-value'
import { numberValue } from './session-scanner-token-values'
import { extractString } from './session-scanner-values'

// Devin stores workspace metadata absent from Windows transcripts in a sibling sessions.db.

export type DevinSessionIndexRow = {
  workingDirectory: string | null
  title: string | null
  model: string | null
  createdAt: string | null
  lastActivityAt: string | null
  hidden: boolean
}

export type DevinSessionsIndex = Map<string, DevinSessionIndexRow>

// Older schemas require only id; discover the remaining columns before querying.
const DEVIN_SESSION_TABLE = 'sessions'
const DEVIN_SESSION_OPTIONAL_COLUMNS = [
  'working_directory',
  'title',
  'model',
  'created_at',
  'last_activity_at',
  'hidden'
] as const

// Share indexes by sidecar signature so database-only edits trigger re-enrichment.
const INDEX_CACHE_LIMIT = 8
const indexCache = new Map<
  string,
  { sidecarPath: string; mtimeMs: number; sizeBytes: number; index: DevinSessionsIndex }
>()
const scanDbFailures = new AsyncLocalStorage<Set<string>>()

/** A contended database must cost one timeout per scan, not one per transcript. */
export function withDevinSessionsDbScan<T>(fn: () => Promise<T>): Promise<T> {
  return scanDbFailures.run(new Set(), fn)
}

export function devinSessionsDbPath(transcriptFilePath: string): string {
  return join(dirname(dirname(transcriptFilePath)), 'sessions.db')
}

/** Watch the WAL when present: commits may leave the main database stat unchanged until checkpoint. */
export async function devinSessionsDbDependencyPath(transcriptFilePath: string): Promise<string> {
  const dbPath = devinSessionsDbPath(transcriptFilePath)
  const walPath = `${dbPath}-wal`
  try {
    await wslGatedStat(walPath, 'scan')
    return walPath
  } catch {
    // Missing or refused WAL probes fall back to observing the database.
    return dbPath
  }
}

/** Observe WAL changes but always open the database itself. */
function devinSessionsDbPathForSidecarPath(sidecarPath: string): string {
  return sidecarPath.endsWith('-wal') ? sidecarPath.slice(0, -'-wal'.length) : sidecarPath
}

/** Unreadable observations stay unknown so later scans retry rather than cache missing enrichment. */
export function devinSessionsIndexForSidecar(sidecar: SessionSidecarObservation | undefined): {
  index: DevinSessionsIndex | null
  unreadable: boolean
} {
  if (sidecar === undefined || sidecar === 'none') {
    return { index: null, unreadable: false }
  }
  if (sidecar === 'unknown') {
    // A failed stat already proved this scan cannot read the share; avoid another open per transcript.
    return { index: null, unreadable: true }
  }
  const dbPath = devinSessionsDbPathForSidecarPath(sidecar.path)
  const failures = scanDbFailures.getStore()
  if (failures?.has(dbPath)) {
    return { index: null, unreadable: true }
  }
  const cached = indexCache.get(dbPath)
  if (
    cached &&
    cached.sidecarPath === sidecar.path &&
    cached.mtimeMs === sidecar.mtimeMs &&
    cached.sizeBytes === sidecar.sizeBytes
  ) {
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
      sidecarPath: sidecar.path,
      mtimeMs: sidecar.mtimeMs,
      sizeBytes: sidecar.sizeBytes,
      index
    })
    return { index, unreadable: false }
  } catch {
    // Retry next scan even if the database stat has not changed.
    failures?.add(dbPath)
    return { index: null, unreadable: true }
  }
}

export function resetDevinSessionsIndexCacheForTests(): void {
  indexCache.clear()
}

/** Read older schemas with available columns; absent sessions/id yields an empty index, while SQLite failures propagate. */
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

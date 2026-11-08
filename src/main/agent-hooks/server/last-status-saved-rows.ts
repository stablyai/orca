import { existsSync } from 'node:fs'

import SyncDatabase from '../../sqlite/sync-database'
import { isSqliteCorruption } from '../../sqlite/sqlite-read-failure'
import { removeVersionedCacheDatabase } from '../../sqlite/versioned-cache-database'
import { LAST_STATUS_FILE_VERSION } from './server-constants'
import type { LastStatusFile } from './server-types'
import { hashContent } from './last-status-legacy-file'

export type RowKind = 'entry' | 'commitment' | 'exits'
export type StoredRow = { kind: RowKind; key: string; payload: string }

export const IMPORTED_LEGACY_HASH = 'imported_legacy_hash'
// Follows LAST_STATUS_FILE_VERSION: a mismatched cache rebuilds empty, as the file did.
export const LAST_STATUS_SCHEMA_VERSION = LAST_STATUS_FILE_VERSION

export const rowId = (kind: RowKind, key: string): string => `${kind}\u0000${key}`

export type SavedRows =
  | { kind: 'rows'; rows: StoredRow[]; importedLegacyHash: string | undefined }
  /** Nothing usable is saved: no file, another schema, or a damaged file (now removed). */
  | { kind: 'empty' }
  /** Saved rows exist but cannot be read now (usually another connection's lock). */
  | { kind: 'unavailable'; error: unknown }

/**
 * Read the saved rows without writing: a read-only connection needs no write lock, so a
 * writer elsewhere cannot block startup the way schema initialization would.
 */
export function readSavedRows(databasePath: string, busyTimeoutMs: number): SavedRows {
  if (!existsSync(databasePath)) {
    return { kind: 'empty' }
  }
  let db: SyncDatabase | null = null
  try {
    db = new SyncDatabase(databasePath, { readonly: true, fileMustExist: true })
    db.pragma(`busy_timeout = ${busyTimeoutMs}`)
    db.exec('BEGIN')
    try {
      const hasMeta = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('meta', 'rows')")
        .all()
      if (hasMeta.length !== 2) {
        return { kind: 'empty' }
      }
      const version = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()
      if (version?.value !== String(LAST_STATUS_SCHEMA_VERSION)) {
        return { kind: 'empty' }
      }
      const marker = db.prepare('SELECT value FROM meta WHERE key = ?').get(IMPORTED_LEGACY_HASH)
      return {
        kind: 'rows',
        rows: readRows(db),
        importedLegacyHash: typeof marker?.value === 'string' ? marker.value : undefined
      }
    } finally {
      if (db.isTransaction) {
        db.exec('COMMIT')
      }
    }
  } catch (error) {
    if (isSqliteCorruption(error)) {
      db?.close()
      db = null
      // Damaged rows hold nothing recoverable; the next write rebuilds the cache.
      try {
        removeVersionedCacheDatabase(databasePath, 'fail-fast')
      } catch (removeError) {
        // A held file stays until a later start; this session reads nothing from it.
        return { kind: 'unavailable', error: removeError }
      }
      return { kind: 'empty' }
    }
    return { kind: 'unavailable', error }
  } finally {
    db?.close()
  }
}

export function readRows(db: SyncDatabase): StoredRow[] {
  return db
    .prepare('SELECT kind, key, payload FROM rows')
    .all()
    .flatMap((row) =>
      isRowKind(row.kind) && typeof row.key === 'string' && typeof row.payload === 'string'
        ? [{ kind: row.kind, key: row.key, payload: row.payload }]
        : []
    )
}

export function readDataVersion(db: SyncDatabase): unknown {
  return db.prepare('PRAGMA data_version').get()?.data_version
}

export function hashRows(rows: readonly StoredRow[]): Map<string, string> {
  return new Map(rows.map((row) => [rowId(row.kind, row.key), hashContent(row.payload)]))
}

export function* rowsOf(file: LastStatusFile): Generator<StoredRow> {
  for (const [key, value] of Object.entries(file.entries)) {
    yield { kind: 'entry', key, payload: JSON.stringify(value) }
  }
  for (const [key, value] of Object.entries(file.authorityCommitments ?? {})) {
    yield { kind: 'commitment', key, payload: JSON.stringify(value) }
  }
  if (file.agentExits && file.agentExits.length > 0) {
    yield { kind: 'exits', key: '', payload: JSON.stringify(file.agentExits) }
  }
}

export function assemble(rows: readonly StoredRow[]): Required<LastStatusFile> {
  const file: Required<LastStatusFile> = {
    version: LAST_STATUS_FILE_VERSION,
    entries: {},
    authorityCommitments: {},
    agentExits: []
  }
  for (const row of rows) {
    let value: unknown
    try {
      value = JSON.parse(row.payload)
    } catch {
      // An unreadable row is dropped here; it is not in the saved document, so a save deletes it.
      continue
    }
    if (row.kind === 'entry') {
      Object.assign(file.entries, { [row.key]: value })
    } else if (row.kind === 'commitment') {
      Object.assign(file.authorityCommitments, { [row.key]: value })
    } else if (Array.isArray(value)) {
      file.agentExits = value
    }
  }
  return file
}

function isRowKind(kind: unknown): kind is RowKind {
  return kind === 'entry' || kind === 'commitment' || kind === 'exits'
}

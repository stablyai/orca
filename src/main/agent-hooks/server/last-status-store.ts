import { dirname, join } from 'node:path'

import type SyncDatabase from '../../sqlite/sync-database'
import { hardenSqliteDatabaseFiles } from '../../sqlite/harden-database-files'
import { isSqliteCorruption } from '../../sqlite/sqlite-read-failure'
import {
  openVersionedCacheDatabase,
  removeVersionedCacheDatabase
} from '../../sqlite/versioned-cache-database'
import type { LastStatusFile } from './server-types'
import { hashContent, LegacyLastStatusFile } from './last-status-legacy-file'
import {
  assemble,
  hashRows,
  IMPORTED_LEGACY_HASH,
  LAST_STATUS_SCHEMA_VERSION,
  readDataVersion,
  readRows,
  readSavedRows,
  rowId,
  rowsOf,
  type StoredRow
} from './last-status-saved-rows'

/**
 * Restart cache for agent status: one row per pane, per authority commitment, plus the exit
 * list. A save rewrites only rows whose content changed, where the whole-file JSON it
 * replaces was rewritten on every save. It runs on the main thread, so it never waits on
 * another connection's lock beyond the caller's small bound; callers retry later instead.
 */
const SCHEMA = {
  version: LAST_STATUS_SCHEMA_VERSION,
  sql: `
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS rows(
  kind TEXT NOT NULL,
  key TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY(kind, key)
) WITHOUT ROWID;
`,
  // Rows hold prompts and assistant messages; keep the directory user-only.
  directoryMode: 0o700,
  // The main thread must not sleep through Windows unlock retries; saves retry instead.
  removal: 'fail-fast' as const
}

export type SavedStatus = { document: unknown; source: 'legacy' | 'rows' }

export function lastStatusDatabasePath(legacyJsonPath: string): string {
  return join(dirname(legacyJsonPath), 'last-status.db')
}

export class LastStatusStore {
  private db: SyncDatabase | null = null
  /** Hashes of the rows on disk as this connection last saw them, labelled by data_version. */
  private baseline: Map<string, string> | undefined
  private dataVersion: unknown
  private savedRows: StoredRow[] | undefined
  /**
   * Set when the saved rows (or the import receipt) could not be read at startup. The session
   * then neither writes nor deletes, so an incomplete view cannot overwrite rows it never
   * read, and the legacy file stays for a later start. This also means authority commitments
   * are not persisted for this session, as when the JSON file was unwritable before.
   */
  private disabled = false
  private readonly legacy: LegacyLastStatusFile
  private readonly databasePath: string

  constructor(legacyJsonPath: string) {
    this.legacy = new LegacyLastStatusFile(legacyJsonPath)
    this.databasePath = lastStatusDatabasePath(legacyJsonPath)
  }

  /** True for a session whose saved rows could not be read; it saves nothing. */
  get isDisabled(): boolean {
    return this.disabled
  }

  /** The saved document (unvalidated) and where it came from, or undefined when none. */
  read(busyTimeoutMs: number): SavedStatus | undefined {
    const legacy = this.legacy.read()
    const saved = readSavedRows(this.databasePath, busyTimeoutMs)
    if (saved.kind === 'unavailable') {
      this.disabled = true
      throw saved.error
    }
    this.savedRows = saved.kind === 'rows' ? saved.rows : []
    if (legacy) {
      // Only an older build writes the file, so it is newer than the rows, unless this build
      // imported exactly these bytes before and could not remove them.
      if (saved.kind !== 'rows' || saved.importedLegacyHash !== legacy.hash) {
        return { document: legacy.document, source: 'legacy' }
      }
      this.legacy.markImported(legacy.hash)
    }
    return this.readRows()
  }

  /** The saved rows from the last read, for when hydration rejects a legacy file. */
  readRows(): SavedStatus | undefined {
    const rows = this.savedRows ?? []
    return rows.length > 0 ? { document: assemble(rows), source: 'rows' } : undefined
  }

  /** Hydration admitted the legacy file read last; it may go once rows hold it. */
  confirmLegacyImport(): void {
    this.legacy.confirmRead()
  }

  /** Hydration rejected the legacy file; drop it after the next commit and keep the rows. */
  rejectLegacy(): void {
    this.legacy.discardRead()
  }

  /** Writes changed rows in one transaction; throws on lock or I/O failure for a later retry. */
  write(file: LastStatusFile, busyTimeoutMs: number): boolean {
    if (this.disabled) {
      return false
    }
    const next = new Map<string, string>()
    const rows: (StoredRow & { hash: string })[] = []
    for (const row of rowsOf(file)) {
      const hash = hashContent(row.payload)
      next.set(rowId(row.kind, row.key), hash)
      rows.push({ ...row, hash })
    }
    const db = this.open(busyTimeoutMs)
    let wrote = false
    try {
      db.exec('BEGIN IMMEDIATE')
      // Sampled under the write lock, so no other commit lands before COMMIT, and this
      // connection's own commit leaves it unchanged. A changed version means stale hashes.
      const version = readDataVersion(db)
      const baseline =
        this.baseline !== undefined && version === this.dataVersion
          ? this.baseline
          : hashRows(readRows(db))
      const upsert = db.prepare(
        'INSERT INTO rows(kind, key, payload) VALUES (?, ?, ?) ON CONFLICT(kind, key) DO UPDATE SET payload = excluded.payload'
      )
      for (const row of rows) {
        const id = rowId(row.kind, row.key)
        if (baseline.get(id) !== row.hash) {
          upsert.run(row.kind, row.key, row.payload)
          wrote = true
        }
      }
      const remove = db.prepare('DELETE FROM rows WHERE kind = ? AND key = ?')
      for (const id of baseline.keys()) {
        if (next.has(id)) {
          continue
        }
        const [kind, key] = id.split('\u0000')
        remove.run(kind, key)
        wrote = true
      }
      const importHash = this.legacy.pendingImportHash
      if (importHash !== undefined) {
        db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run(
          IMPORTED_LEGACY_HASH,
          importHash
        )
      }
      db.exec(wrote || importHash !== undefined ? 'COMMIT' : 'ROLLBACK')
      this.dataVersion = version
      this.baseline = next
    } catch (error) {
      if (db.isTransaction) {
        db.exec('ROLLBACK')
      }
      this.handleFailure(error)
      throw error
    }
    this.legacy.removeIfUnchanged()
    return wrote
  }

  close(): void {
    this.db?.close()
    this.db = null
    this.baseline = undefined
    this.dataVersion = undefined
    this.savedRows = undefined
    this.disabled = false
    this.legacy.reset()
  }

  private open(busyTimeoutMs: number): SyncDatabase {
    if (this.db) {
      this.db.pragma(`busy_timeout = ${busyTimeoutMs}`)
      return this.db
    }
    const db = openVersionedCacheDatabase(this.databasePath, { ...SCHEMA, busyTimeoutMs })
    hardenSqliteDatabaseFiles(this.databasePath)
    this.db = db
    // data_version is per connection; the first write reloads the hashes under its lock.
    this.baseline = undefined
    this.dataVersion = undefined
    return db
  }

  private handleFailure(error: unknown): void {
    if (!isSqliteCorruption(error)) {
      return
    }
    // A damaged cache is rebuilt empty on the next attempt, as the helper does at open.
    this.db?.close()
    this.db = null
    this.baseline = undefined
    this.dataVersion = undefined
    try {
      removeVersionedCacheDatabase(this.databasePath, 'fail-fast')
    } catch {
      // Held by another process (Windows); the next save retries the rebuild.
    }
  }
}

import { existsSync } from 'node:fs'
import {
  planFullRows,
  planRowPatch,
  parseOrNull,
  receiptNames,
  type StoredRow
} from './keyed-json-row-plan'
export { parseKeyedJsonRows } from './keyed-json-row-plan'
import SyncDatabase from '../sync-database'
import {
  openVersionedCacheDatabase,
  removeVersionedCacheDatabase
} from '../versioned-cache-database'
import { hardenSqliteDatabaseFiles } from '../harden-database-files'
import { classifyRowCacheFailure } from './row-cache-failure'
import { readLegacyJsonSource, removeLegacyJsonSource } from './legacy-json-source'

export type KeyedJsonRow = { key: string; json: string }

export type KeyedJsonRowCacheOptions = {
  schemaVersion: number
  /** Lock wait per call. Main-thread callers keep it short and retry later instead. */
  busyTimeoutMs?: number
  /** False opens and closes the database per call, so no handle outlives it (profile moves). */
  holdConnection?: boolean
  /** JSON file older builds wrote; see load(). */
  legacyPath?: string
}

/**
 * What a store hydrates at startup.
 * - rows: the stored rows (no older-build file, or one already imported or rejected).
 * - import: an older build's file is newer than the rows; save `value` with `receipt`.
 * - unavailable: the rows or the file cannot be read now. The store must neither hydrate a
 *   replacement nor save over rows it never read; `legacy` is the file's value if it was read.
 */
export type KeyedJsonRowLoad<T> =
  | { kind: 'rows'; rows: KeyedJsonRow[] }
  | { kind: 'import'; value: T; receipt: string; rows: KeyedJsonRow[] }
  | { kind: 'unavailable'; error: unknown; legacy?: T }

type RowWriteOptions = {
  importReceipt?: string
  busyTimeoutMs?: number
  reinsertKeys?: ReadonlySet<string>
}

const RECEIPT_KEY = 'legacy_import_receipt'
const DEFAULT_BUSY_TIMEOUT_MS = 25
const SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS rows(key TEXT PRIMARY KEY, seq INTEGER NOT NULL, value TEXT NOT NULL);`

/**
 * An ordered list of JSON values, one SQLite row each, so a save writes only the rows whose
 * value or position changed. Corruption rebuilds the file once; busy and unreadable files
 * throw from write(), and callers retry later.
 */
export class KeyedJsonRowCache {
  private db: SyncDatabase | null = null
  private stored = new Map<string, StoredRow>()
  private maxSeq = 0
  private dataVersion: unknown
  private closed = false
  private readonly busyTimeoutMs: number

  constructor(
    readonly path: string,
    private readonly options: KeyedJsonRowCacheOptions
  ) {
    this.busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS
  }

  /**
   * Startup read of the rows and, when configured, the older build's file. That file is newer
   * than the rows unless the rows record importing exactly its bytes; `parse` returning null
   * rejects it. An imported or rejected file is removed here and never replaces the rows.
   */
  load<T>(parse: (text: string) => T | null, busyTimeoutMs?: number): KeyedJsonRowLoad<T> {
    const legacyPath = this.options.legacyPath
    const source = legacyPath ? readLegacyJsonSource(legacyPath) : { kind: 'absent' as const }
    const parsed = source.kind === 'read' ? parseOrNull(parse, source.text) : null
    const legacy = parsed ?? undefined
    const snapshot = this.readSnapshot(busyTimeoutMs ?? this.busyTimeoutMs)
    if (snapshot.kind === 'unavailable') {
      return { kind: 'unavailable', error: snapshot.error, ...(legacy ? { legacy } : {}) }
    }
    if (source.kind === 'unreadable') {
      // A file that may be newer than the rows cannot be ruled out until it can be read.
      return { kind: 'unavailable', error: source.error }
    }
    if (source.kind === 'read' && legacyPath) {
      if (parsed !== null && !receiptNames(snapshot.receipt, source.receipt)) {
        return { kind: 'import', value: parsed, receipt: source.receipt, rows: snapshot.rows }
      }
      // Already imported (its removal failed before) or rejected: the rows stay authoritative.
      removeLegacyJsonSource(legacyPath, source.receipt)
    }
    return { kind: 'rows', rows: snapshot.rows }
  }

  /** Hydration rejected an imported value after load(): remove its file, keep the rows. */
  discardLegacy(receipt: string): void {
    if (this.options.legacyPath) {
      removeLegacyJsonSource(this.options.legacyPath, receipt)
    }
  }

  /**
   * Saves `rows` in order. `importReceipt` records the older build's file these rows now hold,
   * in the same transaction, and removes that file once committed. Throws on failure (busy
   * included); the baseline is unchanged, so a retry is exact.
   */
  write(
    rows: readonly KeyedJsonRow[],
    options: { importReceipt?: string; busyTimeoutMs?: number } = {}
  ): void {
    this.save(() => rows, undefined, options)
  }

  close(): void {
    this.closed = true
    this.closeDatabase()
  }

  /** Addressed updates opt in; an uncertain baseline lazily reconciles the full owner. */
  patch(
    changes: ReadonlyMap<string, string | null>,
    fullRows: () => readonly KeyedJsonRow[],
    options: RowWriteOptions = {}
  ): void {
    this.save(fullRows, changes, options)
  }

  private save(
    fullRows: () => readonly KeyedJsonRow[],
    changes: ReadonlyMap<string, string | null> | undefined,
    options: RowWriteOptions
  ): void {
    const busyTimeoutMs = options.busyTimeoutMs ?? this.busyTimeoutMs
    try {
      this.withRebuild(() => this.commit(fullRows, changes, options, busyTimeoutMs))
    } finally {
      // Late teardown writes open and close their own handle.
      if (this.options.holdConnection === false || this.closed) {
        this.closeDatabase()
      }
    }
    if (options.importReceipt !== undefined && this.options.legacyPath) {
      removeLegacyJsonSource(this.options.legacyPath, options.importReceipt)
    }
  }

  /** One read-only snapshot: another connection's write lock cannot block it. */
  private readSnapshot(busyTimeoutMs: number) {
    // One-shot startup probe, so an unused store creates no file.
    if (!existsSync(this.path)) {
      return { kind: 'rows' as const, rows: [], receipt: undefined }
    }
    return this.readStoredSnapshot(busyTimeoutMs)
  }

  private commit(
    fullRows: () => readonly KeyedJsonRow[],
    changes: ReadonlyMap<string, string | null> | undefined,
    options: RowWriteOptions,
    busyTimeoutMs: number
  ): void {
    const db = this.database(busyTimeoutMs)
    db.pragma(`busy_timeout = ${busyTimeoutMs}`)
    db.exec('BEGIN IMMEDIATE')
    try {
      const baselineValid = db.pragma('data_version', { simple: true }) === this.dataVersion
      if (!baselineValid) {
        this.readBaseline(db)
      }
      const plan =
        changes && baselineValid && options.importReceipt === undefined
          ? planRowPatch(this.stored, this.maxSeq, changes, options.reinsertKeys)
          : planFullRows(this.stored, this.maxSeq, fullRows())
      const upsert = db.prepare(
        `INSERT INTO rows(key, seq, value) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET seq = excluded.seq, value = excluded.value`
      )
      const remove = db.prepare('DELETE FROM rows WHERE key = ?')
      for (const [key, row] of plan.changes) {
        if (row) {
          upsert.run(key, row.seq, row.json)
        } else {
          remove.run(key)
        }
      }
      if (options.importReceipt !== undefined) {
        db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run(
          RECEIPT_KEY,
          options.importReceipt
        )
      }
      // Sample under the write lock; publish the planned baseline only after COMMIT.
      const version = db.pragma('data_version', { simple: true })
      db.exec('COMMIT')
      if (plan.next) {
        this.stored = plan.next
      } else {
        for (const [key, row] of plan.changes) {
          if (row) {
            this.stored.set(key, row)
          } else {
            this.stored.delete(key)
          }
        }
      }
      this.maxSeq = plan.maxSeq
      this.dataVersion = version
    } catch (error) {
      rollback(db)
      // A failed COMMIT may have landed without changing this connection's data_version.
      this.dataVersion = undefined
      throw error
    }
  }

  private readStoredSnapshot(busyTimeoutMs: number) {
    let db: SyncDatabase | null = null
    try {
      db = new SyncDatabase(this.path, { readonly: true, fileMustExist: true })
      db.pragma(`busy_timeout = ${busyTimeoutMs}`)
      db.exec('BEGIN')
      try {
        const tables = db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('meta', 'rows')"
          )
          .all()
        const version =
          tables.length === 2
            ? db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()
            : undefined
        if (version?.value !== String(this.options.schemaVersion)) {
          return { kind: 'rows' as const, rows: [], receipt: undefined }
        }
        const rows = [...readRows(db).stored].map(([key, { json }]) => ({ key, json }))
        const receipt = db.prepare('SELECT value FROM meta WHERE key = ?').get(RECEIPT_KEY)?.value
        return { kind: 'rows' as const, rows, receipt }
      } finally {
        rollback(db)
      }
    } catch (error) {
      if (classifyRowCacheFailure(error) !== 'corrupt') {
        return { kind: 'unavailable' as const, error }
      }
      db?.close()
      db = null
      try {
        removeVersionedCacheDatabase(this.path, 'fail-fast')
      } catch (removeError) {
        return { kind: 'unavailable' as const, error: removeError }
      }
      return { kind: 'rows' as const, rows: [], receipt: undefined }
    } finally {
      db?.close()
    }
  }

  /**
   * Call inside a transaction: the version is sampled with the rows of the same snapshot, and
   * all three are published together, so a failed read never vouches for an older baseline.
   */
  private readBaseline(db: SyncDatabase): void {
    this.dataVersion = undefined
    const version = db.pragma('data_version', { simple: true })
    const { stored, maxSeq } = readRows(db)
    this.stored = stored
    this.maxSeq = maxSeq
    this.dataVersion = version
  }

  /** A damaged page can surface on any statement; rebuild once and redo the operation. */
  private withRebuild<T>(operation: () => T): T {
    try {
      return operation()
    } catch (error) {
      if (classifyRowCacheFailure(error) !== 'corrupt') {
        throw error
      }
      this.closeDatabase()
      // Fail fast: a file held open elsewhere (Windows) throws, and the caller retries later.
      removeVersionedCacheDatabase(this.path, 'fail-fast')
      return operation()
    }
  }

  private database(busyTimeoutMs: number): SyncDatabase {
    if (this.db) {
      return this.db
    }
    const db = openVersionedCacheDatabase(this.path, {
      version: this.options.schemaVersion,
      // The caller's budget covers opening too: schema setup writes, so it can meet the lock.
      busyTimeoutMs,
      removal: 'fail-fast',
      // Rows can hold prompts, PR titles and notification ids; keep them user-only.
      directoryMode: 0o700,
      sql: SCHEMA_SQL
    })
    hardenSqliteDatabaseFiles(this.path)
    this.db = db
    // A fresh connection cannot vouch for a baseline read through an earlier one.
    this.dataVersion = undefined
    this.stored = new Map()
    this.maxSeq = 0
    return db
  }

  private closeDatabase(): void {
    try {
      this.db?.close()
    } catch {
      // Closing a failed handle must not mask the original error.
    }
    this.db = null
  }
}

function readRows(db: SyncDatabase): { stored: Map<string, StoredRow>; maxSeq: number } {
  const stored = new Map<string, StoredRow>()
  let maxSeq = 0
  for (const row of db.prepare('SELECT key, seq, value FROM rows ORDER BY seq').all()) {
    const { key, seq, value } = row
    if (typeof key === 'string' && typeof seq === 'number' && typeof value === 'string') {
      stored.set(key, { seq, json: value })
      maxSeq = Math.max(maxSeq, seq)
    }
  }
  return { stored, maxSeq }
}

function rollback(db: SyncDatabase): void {
  if (db.isTransaction) {
    db.exec('ROLLBACK')
  }
}

import { existsSync } from 'node:fs'
import SyncDatabase from './sync-database'
import {
  isUnusableDatabaseError,
  openVersionedCacheDatabase,
  removeVersionedCacheDatabase
} from './versioned-cache-database'
import { hardenSqliteDatabaseFiles } from './harden-database-files'

export type KeyedJsonRow = { key: string; json: string }

/** Rows of an older build's file plus the receipt identifying that file. */
export type KeyedJsonRowImport = { rows: readonly KeyedJsonRow[]; receipt: string }

export type KeyedJsonRowCacheLoad =
  | { kind: 'rows'; values: unknown[] }
  | { kind: 'unreadable'; error: unknown }

type StoredRow = { seq: number; json: string }
type Snapshot = {
  receipt: unknown
  stored: Map<string, StoredRow>
  maxSeq: number
  values: unknown[]
}

// Callers run on the main thread: a lock held elsewhere must fail fast, not freeze the app.
const BUSY_TIMEOUT_MS = 25
const RECEIPT_KEY = 'legacy_import_receipt'

/**
 * An ordered list of JSON values kept as one SQLite row each, so a save writes only the
 * rows whose value or position changed instead of rewriting the whole list. Corruption
 * rebuilds the file once; busy and unreadable files throw, and callers retry later.
 */
export class KeyedJsonRowCache {
  private db: SyncDatabase | null = null
  private stored = new Map<string, StoredRow>()
  private maxSeq = 0
  private dataVersion: unknown
  private closed = false

  constructor(
    private readonly path: string,
    private readonly schemaVersion: number
  ) {}

  /**
   * Opens the database only when it exists or `legacy` must be imported, so an unused
   * store creates no file. `legacy` replaces the rows unless its receipt shows it was
   * already imported; the receipt commits with the rows, so its source may then be removed.
   */
  load(legacy?: KeyedJsonRowImport): KeyedJsonRowCacheLoad {
    if (!legacy && !existsSync(this.path)) {
      return { kind: 'rows', values: [] }
    }
    let snapshot: Snapshot | undefined
    try {
      // A read-only connection is not blocked by another connection's write lock.
      snapshot = this.readSnapshot()
    } catch (error) {
      if (isBusyError(error)) {
        return { kind: 'unreadable', error }
      }
      // Missing tables, a stale schema or corruption: the writable path repairs those.
    }
    try {
      if (snapshot && (!legacy || snapshot.receipt === legacy.receipt)) {
        this.stored = snapshot.stored
        this.maxSeq = snapshot.maxSeq
        // That connection's version means nothing to ours; the first write re-reads.
        this.dataVersion = undefined
        return { kind: 'rows', values: snapshot.values }
      }
      return this.transient(() =>
        this.withRebuild(() => {
          const db = this.database()
          db.exec('BEGIN')
          let values: unknown[]
          let imported: boolean
          try {
            imported = legacy !== undefined && readReceipt(db) !== legacy.receipt
            values = imported ? [] : this.readBaseline(db)
            db.exec('COMMIT')
          } catch (error) {
            rollback(db)
            throw error
          }
          if (imported && legacy) {
            this.commit(legacy.rows, legacy.receipt)
            values = legacy.rows.flatMap((row) => parse(row.json))
          }
          return { kind: 'rows' as const, values }
        })
      )
    } catch (error) {
      this.closeDatabase()
      return { kind: 'unreadable', error }
    }
  }

  /**
   * Saves `rows` in order; `importReceipt` replaces every stored row and records the import.
   * Throws on failure (busy included); the stored baseline is unchanged so a retry is exact.
   */
  write(rows: readonly KeyedJsonRow[], importReceipt?: string): void {
    this.transient(() => this.withRebuild(() => this.commit(rows, importReceipt)))
  }

  /** Later writes still save, each opening and closing the database itself. */
  close(): void {
    this.closed = true
    this.closeDatabase()
  }

  private commit(rows: readonly KeyedJsonRow[], importReceipt: string | undefined): void {
    const db = this.database()
    db.exec('BEGIN IMMEDIATE')
    try {
      const replaceAll = importReceipt !== undefined
      // Another connection committed since our baseline: diff against what is on disk.
      if (!replaceAll && db.pragma('data_version', { simple: true }) !== this.dataVersion) {
        this.readBaseline(db)
      }
      const baseline = replaceAll ? new Map<string, StoredRow>() : this.stored
      const next = new Map<string, StoredRow>()
      let maxSeq = replaceAll ? 0 : this.maxSeq
      let previous = 0
      for (const { key, json } of rows) {
        const old = baseline.get(key)
        // Keep a row's position while the order allows it; moved rows go after the rest.
        const seq = old && old.seq > previous ? old.seq : ++maxSeq
        previous = seq
        next.set(key, { seq, json })
      }
      if (replaceAll) {
        db.prepare('DELETE FROM rows').run()
        db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run(
          RECEIPT_KEY,
          importReceipt
        )
      }
      const upsert = db.prepare(
        `INSERT INTO rows(key, seq, value) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET seq = excluded.seq, value = excluded.value`
      )
      for (const [key, row] of next) {
        const old = baseline.get(key)
        if (!old || old.seq !== row.seq || old.json !== row.json) {
          upsert.run(key, row.seq, row.json)
        }
      }
      const remove = db.prepare('DELETE FROM rows WHERE key = ?')
      for (const key of baseline.keys()) {
        if (!next.has(key)) {
          remove.run(key)
        }
      }
      // Sampled while the write lock excludes other writers, so no outside commit hides here.
      const version = db.pragma('data_version', { simple: true })
      db.exec('COMMIT')
      this.stored = next
      this.maxSeq = maxSeq
      this.dataVersion = version
    } catch (error) {
      rollback(db)
      throw error
    }
  }

  /** Call inside a transaction: the version is sampled before the rows of the same snapshot. */
  private readBaseline(db: SyncDatabase): unknown[] {
    const version = db.pragma('data_version', { simple: true })
    const { stored, maxSeq, values } = readRows(db)
    this.stored = stored
    this.maxSeq = maxSeq
    this.dataVersion = version
    return values
  }

  /** Rows and import receipt from one read-only snapshot; throws if the schema needs work. */
  private readSnapshot(): Snapshot {
    const db = new SyncDatabase(this.path, { readonly: true, fileMustExist: true })
    try {
      db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`)
      db.exec('BEGIN')
      try {
        const version = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()
        if (version?.value !== String(this.schemaVersion)) {
          throw new Error('Cache schema needs rebuilding')
        }
        return { receipt: readReceipt(db), ...readRows(db) }
      } finally {
        rollback(db)
      }
    } finally {
      db.close()
    }
  }

  /** A damaged page can surface on any statement; rebuild once and redo the operation. */
  private withRebuild<T>(operation: () => T): T {
    try {
      return operation()
    } catch (error) {
      if (!isUnusableDatabaseError(error)) {
        throw error
      }
      this.closeDatabase()
      // Fail fast: a file held open elsewhere (Windows) throws, and the caller retries later.
      removeVersionedCacheDatabase(this.path, 'fail-fast')
      this.stored = new Map()
      this.maxSeq = 0
      return operation()
    }
  }

  /** After close, each operation opens and closes the database itself. */
  private transient<T>(operation: () => T): T {
    const transient = this.closed && this.db === null
    try {
      return operation()
    } finally {
      if (transient) {
        this.closeDatabase()
      }
    }
  }

  private database(): SyncDatabase {
    if (this.db) {
      return this.db
    }
    const db = openVersionedCacheDatabase(this.path, {
      version: this.schemaVersion,
      busyTimeoutMs: BUSY_TIMEOUT_MS,
      removal: 'fail-fast',
      sql: `CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS rows(key TEXT PRIMARY KEY, seq INTEGER NOT NULL, value TEXT NOT NULL);`
    })
    hardenSqliteDatabaseFiles(this.path)
    this.db = db
    // A fresh connection cannot vouch for a baseline read through an earlier one.
    this.dataVersion = undefined
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

function readRows(db: SyncDatabase): Omit<Snapshot, 'receipt'> {
  const stored = new Map<string, StoredRow>()
  const values: unknown[] = []
  let maxSeq = 0
  for (const row of db.prepare('SELECT key, seq, value FROM rows ORDER BY seq').all()) {
    const { key, seq, value } = row
    if (typeof key === 'string' && typeof seq === 'number' && typeof value === 'string') {
      stored.set(key, { seq, json: value })
      maxSeq = Math.max(maxSeq, seq)
      values.push(...parse(value))
    }
  }
  return { stored, maxSeq, values }
}

const BUSY_ERROR = /SQLITE_BUSY|SQLITE_LOCKED|database is locked|database table is locked/i

function isBusyError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }
  const code = 'code' in error ? error.code : undefined
  return (typeof code === 'string' && BUSY_ERROR.test(code)) || BUSY_ERROR.test(error.message)
}

function readReceipt(db: SyncDatabase): unknown {
  return db.prepare('SELECT value FROM meta WHERE key = ?').get(RECEIPT_KEY)?.value
}

function rollback(db: SyncDatabase): void {
  if (db.isTransaction) {
    db.exec('ROLLBACK')
  }
}

function parse(json: string): unknown[] {
  try {
    return [JSON.parse(json)]
  } catch {
    return []
  }
}

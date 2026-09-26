import { existsSync } from 'node:fs'
import type { backup, BackupOptions, DatabaseSync, SQLInputValue } from 'node:sqlite'
import { BunSqliteDatabase, loadBunSqlite } from './bun-sqlite-database'
import { NodeSqliteStatement } from './node-sqlite-statement'
import type { SqliteStatement } from './sqlite-statement'

type SqlitePath = ConstructorParameters<typeof DatabaseSync>[0]

type SyncDatabaseOptions = {
  readonly?: boolean
  fileMustExist?: boolean
  timeout?: number
}

type PragmaOptions = {
  simple?: boolean
}

export type { SqliteStatement } from './sqlite-statement'

// Why: dynamic `IN (?,?,…)` clauses mint a new SQL string per arity, so the cache must stay bounded.
const STATEMENT_CACHE_LIMIT = 256
const AGGREGATE_STAR = /\(\s*\*\s*\)/g
const PRAGMA_STATEMENT = /^\s*PRAGMA\b/i
const SCHEMA_CHANGING_SQL = /\b(?:ALTER|CREATE|DROP|REINDEX|VACUUM|ATTACH|DETACH)\b/i

// Why: node:sqlite builds the first post-schema-change row from stale column names, so a reused
// wildcard SELECT can drop a freshly added column; PRAGMAs are one-shot config, never hot-path.
function isStatementCacheable(sql: string): boolean {
  return !PRAGMA_STATEMENT.test(sql) && !sql.replace(AGGREGATE_STAR, '').includes('*')
}

// Why: SSH companions target Node 18 and import this adapter without opening SQLite.
function loadDatabaseSync(): typeof DatabaseSync {
  if (typeof process.getBuiltinModule !== 'function') {
    throw new Error('node:sqlite is unavailable in this Node.js runtime')
  }
  const sqlite: unknown = process.getBuiltinModule('node:sqlite')
  if (!hasDatabaseSync(sqlite)) {
    throw new Error('node:sqlite is unavailable in this Node.js runtime')
  }
  return sqlite.DatabaseSync
}

function hasDatabaseSync(value: unknown): value is { DatabaseSync: typeof DatabaseSync } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'DatabaseSync' in value &&
    typeof value.DatabaseSync === 'function'
  )
}

function hasBackup(value: unknown): value is { backup: typeof backup } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'backup' in value &&
    typeof value.backup === 'function'
  )
}

export function isSqliteAvailable(): boolean {
  try {
    if (process.versions.bun) {
      return loadBunSqlite() !== undefined
    }
    const sqlite: unknown = process.getBuiltinModule?.('node:sqlite')
    return hasDatabaseSync(sqlite) && hasBackup(sqlite)
  } catch {
    return false
  }
}

class SyncDatabase {
  private readonly db: DatabaseSync | BunSqliteDatabase
  private readonly statementCache = new Map<string, SqliteStatement>()

  constructor(path: SqlitePath, options: SyncDatabaseOptions = {}) {
    if (options.fileMustExist && path !== ':memory:' && !existsSync(path)) {
      throw new Error(`SQLite database does not exist: ${String(path)}`)
    }
    if (process.versions.bun) {
      this.db = new BunSqliteDatabase(path, options)
    } else {
      const DatabaseSync = loadDatabaseSync()
      this.db = new DatabaseSync(path, {
        readOnly: options.readonly,
        timeout: options.timeout
      })
    }
  }

  exec(sql: string): void {
    // Why: drop cached statements before DDL lands so a partially applied batch cannot leave stale ones.
    if (SCHEMA_CHANGING_SQL.test(sql)) {
      this.statementCache.clear()
    }
    this.db.exec(sql)
  }

  prepare(sql: string): SqliteStatement {
    const cached = this.statementCache.get(sql)
    if (cached) {
      this.statementCache.delete(sql)
      this.statementCache.set(sql, cached)
      return cached
    }
    const statement =
      this.db instanceof BunSqliteDatabase
        ? this.db.prepare(sql)
        : new NodeSqliteStatement(this.db.prepare(sql))
    if (isStatementCacheable(sql)) {
      if (this.statementCache.size >= STATEMENT_CACHE_LIMIT) {
        const oldest = this.statementCache.keys().next().value
        if (oldest !== undefined) {
          this.statementCache.delete(oldest)
        }
      }
      this.statementCache.set(sql, statement)
    }
    return statement
  }

  pragma(sql: string, options?: PragmaOptions): unknown {
    const statement = this.prepare(`PRAGMA ${sql}`)
    if (options?.simple) {
      const row = statement.get()
      if (!row) {
        return undefined
      }
      return Object.values(row)[0]
    }
    return statement.all()
  }

  get isTransaction(): boolean {
    return this.db.isTransaction
  }

  /** Keep the source open until completion; Bun's compact snapshot runs synchronously. */
  async backup(path: string, options?: BackupOptions): Promise<void> {
    if (this.db.isTransaction) {
      throw new Error('SQLite backup requires an idle database connection')
    }
    if (this.db instanceof BunSqliteDatabase) {
      if (options && Object.keys(options).length > 0) {
        throw new Error('Incremental SQLite backup options are unavailable in this runtime')
      }
      this.db.backup(path)
      return
    }
    const sqlite: unknown =
      typeof process.getBuiltinModule === 'function'
        ? process.getBuiltinModule('node:sqlite')
        : undefined
    if (!hasBackup(sqlite)) {
      throw new Error('Asynchronous SQLite backup is unavailable in this Node.js runtime')
    }
    await sqlite.backup(this.db, path, options ?? {})
  }

  close(): void {
    this.statementCache.clear()
    this.db.close()
  }
}

namespace SyncDatabase {
  export type Database = SyncDatabase
  export type Statement = SqliteStatement
  export type BindValue = SQLInputValue
}

export default SyncDatabase

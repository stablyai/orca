import { existsSync } from 'node:fs'
import type {
  backup,
  BackupOptions,
  DatabaseSync,
  FunctionOptions,
  SQLInputValue
} from 'node:sqlite'
import { hasNodeSqliteReaderApi } from './node-sqlite-reader-api'
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

// Dynamic IN arity creates unique SQL strings; bound the statement cache.
const STATEMENT_CACHE_LIMIT = 256
const AGGREGATE_STAR = /\(\s*\*\s*\)/g
const PRAGMA_STATEMENT = /^\s*PRAGMA\b/i
const SCHEMA_CHANGING_SQL = /\b(?:ALTER|CREATE|DROP|REINDEX|VACUUM|ATTACH|DETACH)\b/i

// Reused wildcard rows can retain stale column names after DDL; PRAGMAs are one-shot settings.
function isStatementCacheable(sql: string): boolean {
  return !PRAGMA_STATEMENT.test(sql) && !sql.replace(AGGREGATE_STAR, '').includes('*')
}

// Node 18 SSH companions import this module without opening SQLite; load the builtin lazily.
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
    const sqlite: unknown = process.getBuiltinModule?.('node:sqlite')
    return hasNodeSqliteReaderApi(sqlite)
  } catch {
    return false
  }
}

class SyncDatabase {
  private readonly db: DatabaseSync
  private readonly statementCache = new Map<string, SqliteStatement>()

  constructor(path: SqlitePath, options: SyncDatabaseOptions = {}) {
    if (options.fileMustExist && path !== ':memory:' && !existsSync(path)) {
      throw new Error(`SQLite database does not exist: ${String(path)}`)
    }
    const DatabaseSync = loadDatabaseSync()
    this.db = new DatabaseSync(path, {
      readOnly: options.readonly,
      timeout: options.timeout
    })
  }

  exec(sql: string): void {
    // Invalidate before DDL so partially applied batches cannot retain stale statements.
    if (SCHEMA_CHANGING_SQL.test(sql)) {
      this.statementCache.clear()
    }
    this.db.exec(sql)
  }

  function(
    name: string,
    options: FunctionOptions,
    fn: Parameters<DatabaseSync['function']>[1]
  ): void {
    this.db.function(name, options, fn)
  }

  prepare(sql: string): SqliteStatement {
    const cached = this.statementCache.get(sql)
    if (cached) {
      this.statementCache.delete(sql)
      this.statementCache.set(sql, cached)
      return cached
    }
    const statement = new NodeSqliteStatement(this.db.prepare(sql))
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

  /** Keep the source open until completion. */
  async backup(path: string, options?: BackupOptions): Promise<void> {
    if (this.db.isTransaction) {
      throw new Error('SQLite backup requires an idle database connection')
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

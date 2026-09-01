import { existsSync } from 'node:fs'
import type { DatabaseSync, StatementSync, SQLInputValue } from 'node:sqlite'

type SqlitePath = ConstructorParameters<typeof DatabaseSync>[0]

type SyncDatabaseOptions = {
  readonly?: boolean
  fileMustExist?: boolean
  timeout?: number
}

type PragmaOptions = {
  simple?: boolean
}

export type SqliteStatement = StatementSync

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
// Bun-backed orcad uses Bun's synchronous driver through the same narrow database shape.
function loadDatabaseSync(): typeof DatabaseSync {
  if (typeof process.getBuiltinModule !== 'function') {
    throw new Error('node:sqlite is unavailable in this Node.js runtime')
  }
  const nodeSqlite = process.getBuiltinModule('node:sqlite') as
    | { DatabaseSync?: typeof DatabaseSync }
    | undefined
  if (typeof nodeSqlite?.DatabaseSync === 'function') {
    return nodeSqlite.DatabaseSync
  }

  type BunDatabase = Pick<DatabaseSync, 'close' | 'exec' | 'prepare'>
  type BunDatabaseConstructor = new (
    path: SqlitePath,
    options: { readonly?: boolean; strict: boolean }
  ) => BunDatabase
  const bunSqlite = process.getBuiltinModule('bun:sqlite') as
    | { Database?: BunDatabaseConstructor }
    | undefined
  if (typeof bunSqlite?.Database !== 'function') {
    throw new Error('node:sqlite is unavailable in this Node.js runtime')
  }
  const BunDatabase = bunSqlite.Database

  return class BunDatabaseSync {
    private readonly database: BunDatabase

    constructor(path: SqlitePath, options: { readOnly?: boolean; timeout?: number } = {}) {
      this.database = new BunDatabase(path, {
        ...(options.readOnly ? { readonly: true } : {}),
        strict: true
      })
      if (options.timeout !== undefined && Number.isFinite(options.timeout)) {
        this.database.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.trunc(options.timeout))}`)
      }
    }

    exec(sql: string): void {
      this.database.exec(sql)
    }

    prepare(sql: string): StatementSync {
      return this.database.prepare(sql)
    }

    close(): void {
      this.database.close()
    }
  } as unknown as typeof DatabaseSync
}

class SyncDatabase {
  private readonly db: DatabaseSync
  private readonly statementCache = new Map<string, StatementSync>()

  constructor(path: SqlitePath, options: SyncDatabaseOptions = {}) {
    if (
      options.fileMustExist &&
      typeof path === 'string' &&
      path !== ':memory:' &&
      !existsSync(path)
    ) {
      throw new Error(`SQLite database does not exist: ${path}`)
    }
    const DatabaseSync = loadDatabaseSync()
    this.db = new DatabaseSync(path, {
      readOnly: options.readonly,
      timeout: options.timeout
    })
  }

  exec(sql: string): void {
    // Why: drop cached statements before DDL lands so a partially applied batch cannot leave stale ones.
    if (SCHEMA_CHANGING_SQL.test(sql)) {
      this.statementCache.clear()
    }
    this.db.exec(sql)
  }

  prepare(sql: string): StatementSync {
    const cached = this.statementCache.get(sql)
    if (cached) {
      this.statementCache.delete(sql)
      this.statementCache.set(sql, cached)
      return cached
    }
    const statement = this.db.prepare(sql)
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
    const statement = this.db.prepare(`PRAGMA ${sql}`)
    if (options?.simple) {
      const row = statement.get()
      if (!row) {
        return undefined
      }
      return Object.values(row)[0]
    }
    return statement.all()
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

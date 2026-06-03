import { existsSync } from 'node:fs'
import { DatabaseSync, type StatementSync, type SQLInputValue } from 'node:sqlite'

// Why: keep existing synchronous DB call sites on a tiny adapter while using
// Electron's built-in Node SQLite instead of a third-party native addon.
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

class SyncDatabase {
  private readonly db: DatabaseSync

  constructor(path: SqlitePath, options: SyncDatabaseOptions = {}) {
    if (
      options.fileMustExist &&
      typeof path === 'string' &&
      path !== ':memory:' &&
      !existsSync(path)
    ) {
      throw new Error(`SQLite database does not exist: ${path}`)
    }
    this.db = new DatabaseSync(path, {
      readOnly: options.readonly,
      timeout: options.timeout
    })
  }

  exec(sql: string): void {
    this.db.exec(sql)
  }

  prepare(sql: string): StatementSync {
    return this.db.prepare(sql)
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
    this.db.close()
  }
}

namespace SyncDatabase {
  export type Database = SyncDatabase
  export type Statement = SqliteStatement
  export type BindValue = SQLInputValue
}

export default SyncDatabase

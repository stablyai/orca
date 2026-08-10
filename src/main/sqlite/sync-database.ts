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

// Why: SSH companions target Node 18 and import this adapter without opening SQLite.
function loadDatabaseSync(): typeof DatabaseSync {
  if (typeof process.getBuiltinModule !== 'function') {
    throw new Error('node:sqlite is unavailable in this Node.js runtime')
  }
  return (process.getBuiltinModule('node:sqlite') as { DatabaseSync: typeof DatabaseSync })
    .DatabaseSync
}

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
    const DatabaseSync = loadDatabaseSync()
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

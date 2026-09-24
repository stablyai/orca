import type { DatabaseSync } from 'node:sqlite'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { BunSqliteStatement, type BunStatement } from './bun-sqlite-statement'
import { initializeBunReadonlyWal } from './bun-readonly-wal'

type BunDatabase = {
  exec(sql: string): void
  prepare(sql: string): BunStatement
  readonly inTransaction: boolean
  close(throwOnError: boolean): void
  fileControl(command: number, value: Int32Array): number
}

type BunSqlite = {
  Database: new (path: string, flags: number) => BunDatabase
}

const SQLITE_OPEN_READONLY = 0x01
const SQLITE_OPEN_READWRITE = 0x02
const SQLITE_OPEN_CREATE = 0x04
const SQLITE_OPEN_URI = 0x40
const SQLITE_FCNTL_PERSIST_WAL = 10

export function loadBunSqlite(): BunSqlite | undefined {
  if (!process.versions.bun || typeof process.getBuiltinModule !== 'function') {
    return undefined
  }
  const sqlite: unknown = process.getBuiltinModule('bun:sqlite')
  return isBunSqlite(sqlite) ? sqlite : undefined
}

function isBunSqlite(value: unknown): value is BunSqlite {
  return (
    typeof value === 'object' &&
    value !== null &&
    'Database' in value &&
    typeof value.Database === 'function'
  )
}

export class BunSqliteDatabase {
  private readonly database: BunDatabase

  constructor(
    path: ConstructorParameters<typeof DatabaseSync>[0],
    options: { readonly?: boolean; fileMustExist?: boolean; timeout?: number } = {}
  ) {
    const sqlite = loadBunSqlite()
    if (!sqlite) {
      throw new Error('SQLite is unavailable in this runtime')
    }
    const filename =
      path instanceof URL ? fileURLToPath(path) : typeof path === 'string' ? path : path.toString()
    const flags = options.readonly
      ? SQLITE_OPEN_READONLY
      : SQLITE_OPEN_READWRITE | (options.fileMustExist ? 0 : SQLITE_OPEN_CREATE)
    this.database = new sqlite.Database(
      filename === ':memory:' || filename === '' ? filename : sqliteFileUri(filename),
      // URI parsing defaults differ between the platform SQLite libraries.
      flags | SQLITE_OPEN_URI
    )
    try {
      if (process.platform === 'darwin' && filename !== ':memory:' && filename !== '') {
        // Apple's default retains WAL files; match the other shipped SQLite drivers.
        if (this.database.fileControl(SQLITE_FCNTL_PERSIST_WAL, new Int32Array(2)) !== 0) {
          throw new Error('SQLite cannot configure WAL cleanup')
        }
        if (options.readonly) {
          const statement = this.database.prepare('PRAGMA database_list')
          try {
            const path = statement.get()?.file
            if (typeof path !== 'string' || path.length === 0) {
              throw new Error('SQLite did not report its database filename')
            }
            // SQLite resolves symlinks before locating its sidecars.
            initializeBunReadonlyWal(path)
          } finally {
            statement.finalize()
          }
        }
      }
      const timeout = options.timeout ?? 0
      if (!Number.isSafeInteger(timeout) || timeout < 0 || timeout > 2_147_483_647) {
        throw new RangeError('SQLite busy timeout must be a nonnegative 32-bit integer')
      }
      this.database.exec(`PRAGMA foreign_keys = ON; PRAGMA busy_timeout = ${timeout}`)
    } catch (error) {
      this.database.close(true)
      throw error
    }
  }

  exec(sql: string): void {
    this.database.exec(sql)
  }

  prepare(sql: string): BunSqliteStatement {
    return new BunSqliteStatement(this.database.prepare(sql), () => this.database.prepare(sql))
  }

  get isTransaction(): boolean {
    return this.database.inTransaction
  }

  /** Logical snapshot; implicit rowids may change. The caller runs this in its backup worker. */
  backup(path: string): void {
    const statement = this.database.prepare('VACUUM INTO ?')
    try {
      statement.run(sqliteFileUri(path))
    } finally {
      statement.finalize()
    }
  }

  close(): void {
    this.database.close(true)
  }
}

function sqliteFileUri(path: string): string {
  const url = pathToFileURL(path)
  if (url.hostname) {
    const hostname = url.hostname
    url.hostname = ''
    // SQLite accepts UNC paths with an empty URI authority on Windows.
    url.pathname = `//${hostname}${url.pathname}`
  }
  return url.href
}

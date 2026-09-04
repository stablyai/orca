import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import pg from 'pg'
import { pushSchemaStatements } from './push-schema.js'

const POSTGRES_LOCK_TIMEOUT_MS = 1_000
const POSTGRES_CONNECTION_TIMEOUT_MS = 2_000
const POSTGRES_STATEMENT_TIMEOUT_MS = 5_000
const POSTGRES_IDLE_TRANSACTION_TIMEOUT_MS = 5_000
const POSTGRES_TRANSACTION_ATTEMPTS = 3
const POSTGRES_RETRY_MAX_DELAY_MS = 25

export type SqlRow = Record<string, unknown>

export interface PushDatabase {
  readonly dialect: 'sqlite' | 'postgres'
  query(sql: string, params?: unknown[]): Promise<SqlRow[]>
  transaction<T>(operation: (transaction: PushDatabase) => Promise<T>): Promise<T>
  close(): Promise<void>
}

function postgresSql(sql: string): string {
  let index = 0
  return sql.replace(/\?/g, () => `$${++index}`)
}

function returnsRows(sql: string): boolean {
  return /^\s*(select|with)/i.test(sql) || /returning/i.test(sql)
}

class SqliteTransaction implements PushDatabase {
  readonly dialect = 'sqlite' as const

  constructor(protected readonly database: DatabaseSync) {}

  async query(sql: string, params: unknown[] = []): Promise<SqlRow[]> {
    const statement = this.database.prepare(sql)
    const bound = params.map((value) => (value === undefined ? null : value)) as never[]
    if (returnsRows(sql)) return statement.all(...bound) as SqlRow[]
    const result = statement.run(...bound)
    return [{ changes: Number(result.changes) }]
  }

  async transaction<T>(operation: (transaction: PushDatabase) => Promise<T>): Promise<T> {
    return await operation(this)
  }

  async close(): Promise<void> {}
}

class SqliteDatabase extends SqliteTransaction {
  // node:sqlite is synchronous and has no nested transactions, so overlapping
  // callers are serialized behind one tail promise instead of racing BEGIN.
  private tail: Promise<void> = Promise.resolve()

  override async query(sql: string, params: unknown[] = []): Promise<SqlRow[]> {
    await this.tail
    return await super.query(sql, params)
  }

  override async transaction<T>(operation: (transaction: PushDatabase) => Promise<T>): Promise<T> {
    const previous = this.tail
    let release!: () => void
    this.tail = new Promise((resolve) => (release = resolve))
    await previous
    this.database.exec('BEGIN IMMEDIATE')
    const transaction = new SqliteTransaction(this.database)
    try {
      const result = await operation(transaction)
      this.database.exec('COMMIT')
      return result
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    } finally {
      release()
    }
  }

  override async close(): Promise<void> {
    await this.tail
    this.database.close()
  }
}

class PostgresTransaction implements PushDatabase {
  readonly dialect = 'postgres' as const

  constructor(private readonly client: pg.PoolClient) {}

  async query(sql: string, params: unknown[] = []): Promise<SqlRow[]> {
    const result = await this.client.query(postgresSql(sql), params)
    return returnsRows(sql) ? (result.rows as SqlRow[]) : [{ changes: result.rowCount ?? 0 }]
  }

  async transaction<T>(operation: (transaction: PushDatabase) => Promise<T>): Promise<T> {
    return await operation(this)
  }

  async close(): Promise<void> {}
}

function retryablePostgresTransactionError(error: unknown): boolean {
  const code = String((error as { code?: unknown }).code)
  return code === '40P01' || code === '40001' || code === '55P03'
}

async function waitForPostgresRetry(): Promise<void> {
  const delayMs = Math.floor(Math.random() * (POSTGRES_RETRY_MAX_DELAY_MS + 1))
  await new Promise((resolve) => setTimeout(resolve, delayMs))
}

class PostgresDatabase implements PushDatabase {
  readonly dialect = 'postgres' as const

  constructor(private readonly pool: pg.Pool) {}

  async query(sql: string, params: unknown[] = []): Promise<SqlRow[]> {
    const client = await this.pool.connect()
    try {
      const result = await client.query(postgresSql(sql), params)
      return returnsRows(sql) ? (result.rows as SqlRow[]) : [{ changes: result.rowCount ?? 0 }]
    } finally {
      client.release()
    }
  }

  async transaction<T>(operation: (transaction: PushDatabase) => Promise<T>): Promise<T> {
    for (let attempt = 1; attempt <= POSTGRES_TRANSACTION_ATTEMPTS; attempt++) {
      const client = await this.pool.connect()
      try {
        await client.query('BEGIN')
        const result = await operation(new PostgresTransaction(client))
        await client.query('COMMIT')
        return result
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined)
        if (
          !retryablePostgresTransactionError(error) ||
          attempt === POSTGRES_TRANSACTION_ATTEMPTS
        ) {
          throw error
        }
        console.warn(
          JSON.stringify({
            event: 'orca_push_postgres_transaction_retry',
            code: String((error as { code?: unknown }).code),
            attempt
          })
        )
      } finally {
        client.release()
      }
      // A PostgreSQL transaction is unusable after an abort, so retry all work
      // on a fresh pooled client with a small full-jitter delay.
      await waitForPostgresRetry()
    }
    throw new Error('postgres_transaction_retry_exhausted')
  }

  async close(): Promise<void> {
    await this.pool.end()
  }
}

async function applySchema(database: PushDatabase): Promise<void> {
  for (const statement of pushSchemaStatements()) await database.query(statement)
}

export function absorbPostgresIdleClientErrors(pool: Pick<pg.Pool, 'on'>): void {
  pool.on('error', () => {
    // node-postgres removes failed idle clients itself; an unhandled 'error'
    // would crash the service and turn a SQL blip into a restart loop.
    console.warn('[orca-push] idle PostgreSQL client failed')
  })
}

export async function openPushDatabase(input: {
  databaseUrl?: string
  dataDir: string
  poolMax?: number
  applicationName?: string
}): Promise<PushDatabase> {
  let database: PushDatabase
  if (input.databaseUrl) {
    const pool = new pg.Pool({
      connectionString: input.databaseUrl,
      max: input.poolMax ?? 10,
      application_name: input.applicationName,
      connectionTimeoutMillis: POSTGRES_CONNECTION_TIMEOUT_MS,
      statement_timeout: POSTGRES_STATEMENT_TIMEOUT_MS,
      lock_timeout: POSTGRES_LOCK_TIMEOUT_MS,
      idle_in_transaction_session_timeout: POSTGRES_IDLE_TRANSACTION_TIMEOUT_MS
    })
    absorbPostgresIdleClientErrors(pool)
    database = new PostgresDatabase(pool)
  } else {
    mkdirSync(input.dataDir, { recursive: true })
    const sqlite = new DatabaseSync(join(input.dataDir, 'orca-push.sqlite'))
    sqlite.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
    database = new SqliteDatabase(sqlite)
  }
  try {
    await applySchema(database)
    return database
  } catch (error) {
    await database.close().catch(() => undefined)
    throw error
  }
}

export async function openInMemoryPushDatabase(): Promise<PushDatabase> {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA foreign_keys = ON;')
  const database = new SqliteDatabase(sqlite)
  await applySchema(database)
  return database
}

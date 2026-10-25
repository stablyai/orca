import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import pg from 'pg'
import { parseIntoClientConfig } from 'pg-connection-string'
import { applyPostgresSchema } from '@orca-cloud/postgres-schema'
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
  // Serializes every transaction that reads then writes the same identity's
  // quota rows. Must be called inside a transaction; it releases at commit.
  lockQuotaScope(key: string): Promise<void>
  // Non-blocking variant: false means another transaction holds the scope.
  tryLockScope(key: string): Promise<boolean>
  // Shared try-lock: holders of one key coexist, and an exclusive holder excludes them all.
  tryLockSharedScope(key: string): Promise<boolean>
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

  // BEGIN IMMEDIATE already holds SQLite’s single writer lock.
  async lockQuotaScope(): Promise<void> {}

  async tryLockScope(): Promise<boolean> {
    return true
  }

  async tryLockSharedScope(): Promise<boolean> {
    return true
  }

  async close(): Promise<void> {}
}

class SqliteDatabase extends SqliteTransaction {
  // Serialize callers: synchronous node:sqlite has no nested transactions, so overlapping BEGIN would race.
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
    try {
      this.database.exec('BEGIN IMMEDIATE')
      const transaction = new SqliteTransaction(this.database)
      try {
        const result = await operation(transaction)
        this.database.exec('COMMIT')
        return result
      } catch (error) {
        this.database.exec('ROLLBACK')
        throw error
      }
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

  // READ COMMITTED lets a concurrent count-then-insert read the same
  // under-quota total, so the identity is serialized for the whole transaction.
  async lockQuotaScope(key: string): Promise<void> {
    await this.query('SELECT pg_advisory_xact_lock(hashtext(?::text))', [key])
  }

  async tryLockScope(key: string): Promise<boolean> {
    const [row] = await this.query('SELECT pg_try_advisory_xact_lock(hashtext(?::text)) AS locked', [
      key
    ])
    return row?.locked === true
  }

  async tryLockSharedScope(key: string): Promise<boolean> {
    const [row] = await this.query(
      'SELECT pg_try_advisory_xact_lock_shared(hashtext(?::text)) AS locked',
      [key]
    )
    return row?.locked === true
  }

  async close(): Promise<void> {}
}

function retryablePostgresTransactionError(error: unknown): boolean {
  const code = String((error as { code?: unknown }).code)
  // 57014 statement timeout aborts transactions like lock timeout; use the same bounded retry.
  return code === '40P01' || code === '40001' || code === '55P03' || code === '57014'
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

  // Outside an explicit transaction, implicit commit releases the advisory lock before any protected read.
  async lockQuotaScope(): Promise<void> {
    throw new Error('lock_quota_scope_requires_transaction')
  }

  async tryLockScope(): Promise<boolean> {
    throw new Error('lock_quota_scope_requires_transaction')
  }

  async tryLockSharedScope(): Promise<boolean> {
    throw new Error('lock_quota_scope_requires_transaction')
  }

  async close(): Promise<void> {
    await this.pool.end()
  }
}

async function applySchema(database: PushDatabase): Promise<void> {
  for (const statement of pushSchemaStatements()) await database.query(statement)
}

// DDL may outlast request statement_timeout; apply once on a separate untimed connection, closed before serving, or every startup repeats the failure.
async function applySchemaOnUntimedPool(
  databaseUrl: string,
  applicationName: string | undefined
): Promise<void> {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 1,
    application_name: applicationName ? `${applicationName}/schema` : undefined,
    connectionTimeoutMillis: POSTGRES_CONNECTION_TIMEOUT_MS,
    statement_timeout: 0,
    lock_timeout: POSTGRES_LOCK_TIMEOUT_MS,
    idle_in_transaction_session_timeout: POSTGRES_IDLE_TRANSACTION_TIMEOUT_MS
  })
  absorbPostgresIdleClientErrors(pool)
  const database = new PostgresDatabase(pool)
  try {
    await applyPostgresSchema(pushSchemaStatements(), (statement) => database.query(statement), {
      eventPrefix: 'orca_push_postgres_schema',
      // No catalog pre-check: lock timeout cannot prove DDL already exists, so retain bounded retry.
      retryLockTimeout: true
    })
  } finally {
    await database.close().catch(() => undefined)
  }
}

export function absorbPostgresIdleClientErrors(pool: Pick<pg.Pool, 'on'>): void {
  pool.on('error', () => {
    // Handle idle pg errors after the pool removes failed clients; otherwise transient SQL faults crash-loop the service.
    console.warn('[orca-push] idle PostgreSQL client failed')
  })
}

export async function openPushDatabase(input: {
  databaseUrl?: string
  dataDir: string
  poolMax?: number
  applicationName?: string
  readOnly?: boolean
}): Promise<PushDatabase> {
  let database: PushDatabase
  if (input.databaseUrl) {
    if (!input.readOnly) await applySchemaOnUntimedPool(input.databaseUrl, input.applicationName)
    let connection: pg.ClientConfig = { connectionString: input.databaseUrl }
    if (input.readOnly) {
      connection = parseIntoClientConfig(input.databaseUrl)
      // A URL parameter must not trigger a second parse that overrides read-only options.
      delete connection.connectionString
      connection.options = `${connection.options ?? ''} -c default_transaction_read_only=on`.trim()
    }
    const pool = new pg.Pool({
      ...connection,
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
    const sqlite = new DatabaseSync(join(input.dataDir, 'orca-push.sqlite'), {
      readOnly: input.readOnly ?? false
    })
    if (!input.readOnly) sqlite.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
    database = new SqliteDatabase(sqlite)
  }
  if (database.dialect === 'postgres' || input.readOnly) return database
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

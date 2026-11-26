import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import pg from 'pg'
import { parseIntoClientConfig } from 'pg-connection-string'
import { applyPostgresSchema, schemaLockTarget } from '@orca-cloud/postgres-schema'
import { applyOwnedPostgresSchema } from './schema-migration-owner.js'

const POSTGRES_LOCK_TIMEOUT_MS = 1_000
const POSTGRES_CONNECTION_TIMEOUT_MS = 2_000
const POSTGRES_STATEMENT_TIMEOUT_MS = 5_000
const POSTGRES_IDLE_TRANSACTION_TIMEOUT_MS = 5_000
const POSTGRES_TRANSACTION_ATTEMPTS = 3
const POSTGRES_RETRY_MAX_DELAY_MS = 25

export type SqlRow = Record<string, unknown>

export type CloudDatabase = {
  readonly dialect: 'sqlite' | 'postgres'
  query(sql: string, params?: unknown[]): Promise<SqlRow[]>
  transaction<T>(operation: (transaction: CloudDatabase) => Promise<T>): Promise<T>
  // Serializes every transaction that reads then writes the same identity's
  // quota rows. Must be called inside a transaction; it releases at commit.
  lockQuotaScope(key: string): Promise<void>
  // Non-blocking variant: false means another transaction holds the scope.
  tryLockScope(key: string): Promise<boolean>
  // Shared try-lock: holders of one key coexist, and an exclusive holder excludes them all.
  tryLockSharedScope(key: string): Promise<boolean>
  // Runs fn after this transaction commits; never on rollback, and a retried attempt drops the
  // earlier attempt's. A nested transaction joins the outer one. Throws outside a transaction.
  // A throwing fn is logged and ignored: the commit stands.
  afterCommit(fn: () => void): void
  close(): Promise<void>
}

// One transaction attempt's afterCommit callbacks.
class AfterCommitQueue {
  private callbacks: (() => void)[] | null = []

  add(fn: () => void): void {
    if (!this.callbacks) {
      throw new Error('after_commit_requires_open_transaction')
    }
    this.callbacks.push(fn)
  }

  discard(): void {
    this.callbacks = null
  }

  run(): void {
    const callbacks = this.callbacks ?? []
    this.callbacks = null
    for (const fn of callbacks) {
      try {
        const result: unknown = fn()
        if (result instanceof Promise) {
          result.catch(logAfterCommitFailure)
        }
      } catch (error) {
        logAfterCommitFailure(error)
      }
    }
  }
}

function logAfterCommitFailure(error: unknown): void {
  console.warn(
    JSON.stringify({
      event: 'orca_cloud_database_after_commit_failed',
      error: error instanceof Error ? error.name : typeof error
    })
  )
}

function postgresSql(sql: string): string {
  let index = 0
  return sql.replace(/\?/g, () => `$${++index}`)
}

function returnsRows(sql: string): boolean {
  return /^\s*(select|with)/i.test(sql) || /returning/i.test(sql)
}

class SqliteTransaction implements CloudDatabase {
  readonly dialect = 'sqlite' as const

  constructor(
    protected readonly database: DatabaseSync,
    private readonly afterCommitQueue?: AfterCommitQueue
  ) {}

  async query(sql: string, params: unknown[] = []): Promise<SqlRow[]> {
    const statement = this.database.prepare(sql)
    const bound = params.map((value) => (value === undefined ? null : value)) as never[]
    if (returnsRows(sql)) {
      return statement.all(...bound) as SqlRow[]
    }
    const result = statement.run(...bound)
    return [{ changes: Number(result.changes) }]
  }

  async transaction<T>(operation: (transaction: CloudDatabase) => Promise<T>): Promise<T> {
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

  afterCommit(fn: () => void): void {
    if (!this.afterCommitQueue) {
      throw new Error('after_commit_requires_transaction')
    }
    this.afterCommitQueue.add(fn)
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

  override async transaction<T>(operation: (transaction: CloudDatabase) => Promise<T>): Promise<T> {
    const previous = this.tail
    let release!: () => void
    this.tail = new Promise((resolve) => (release = resolve))
    await previous
    const afterCommit = new AfterCommitQueue()
    let result: T
    try {
      this.database.exec('BEGIN IMMEDIATE')
      const transaction = new SqliteTransaction(this.database, afterCommit)
      try {
        result = await operation(transaction)
        this.database.exec('COMMIT')
      } catch (error) {
        afterCommit.discard()
        this.database.exec('ROLLBACK')
        throw error
      }
    } finally {
      release()
    }
    afterCommit.run()
    return result
  }

  override async close(): Promise<void> {
    await this.tail
    this.database.close()
  }
}

class PostgresTransaction implements CloudDatabase {
  readonly dialect = 'postgres' as const

  constructor(
    private readonly client: pg.ClientBase,
    private readonly afterCommitQueue?: AfterCommitQueue
  ) {}

  async query(sql: string, params: unknown[] = []): Promise<SqlRow[]> {
    const result = await this.client.query(postgresSql(sql), params)
    return returnsRows(sql) ? (result.rows as SqlRow[]) : [{ changes: result.rowCount ?? 0 }]
  }

  async transaction<T>(operation: (transaction: CloudDatabase) => Promise<T>): Promise<T> {
    return await operation(this)
  }

  // READ COMMITTED lets a concurrent count-then-insert read the same
  // under-quota total, so the identity is serialized for the whole transaction.
  async lockQuotaScope(key: string): Promise<void> {
    await this.query('SELECT pg_advisory_xact_lock(hashtext(?::text))', [key])
  }

  async tryLockScope(key: string): Promise<boolean> {
    const [row] = await this.query(
      'SELECT pg_try_advisory_xact_lock(hashtext(?::text)) AS locked',
      [key]
    )
    return row?.locked === true
  }

  async tryLockSharedScope(key: string): Promise<boolean> {
    const [row] = await this.query(
      'SELECT pg_try_advisory_xact_lock_shared(hashtext(?::text)) AS locked',
      [key]
    )
    return row?.locked === true
  }

  afterCommit(fn: () => void): void {
    if (!this.afterCommitQueue) {
      throw new Error('after_commit_requires_transaction')
    }
    this.afterCommitQueue.add(fn)
  }

  async close(): Promise<void> {}
}

// One transaction on a caller's own connection, such as the one holding a session lock.
export async function runClientTransaction<T>(
  client: pg.ClientBase,
  operation: (transaction: CloudDatabase) => Promise<T>
): Promise<T> {
  const afterCommit = new AfterCommitQueue()
  let result: T
  try {
    await client.query('BEGIN')
    result = await operation(new PostgresTransaction(client, afterCommit))
    // COMMIT of an aborted transaction (a caught SQL error) rolls back and reports ROLLBACK.
    const commit = await client.query('COMMIT')
    if (commit.command !== 'COMMIT') {
      afterCommit.discard()
    }
  } catch (error) {
    afterCommit.discard()
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  }
  afterCommit.run()
  return result
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

class PostgresDatabase implements CloudDatabase {
  readonly dialect = 'postgres' as const

  constructor(
    private readonly pool: pg.Pool,
    private readonly service: string
  ) {}

  async query(sql: string, params: unknown[] = []): Promise<SqlRow[]> {
    const client = await this.pool.connect()
    try {
      const result = await client.query(postgresSql(sql), params)
      return returnsRows(sql) ? (result.rows as SqlRow[]) : [{ changes: result.rowCount ?? 0 }]
    } finally {
      client.release()
    }
  }

  async transaction<T>(operation: (transaction: CloudDatabase) => Promise<T>): Promise<T> {
    for (let attempt = 1; attempt <= POSTGRES_TRANSACTION_ATTEMPTS; attempt++) {
      const client = await this.pool.connect()
      try {
        return await runClientTransaction(client, operation)
      } catch (error) {
        if (
          !retryablePostgresTransactionError(error) ||
          attempt === POSTGRES_TRANSACTION_ATTEMPTS
        ) {
          throw error
        }
        console.warn(
          JSON.stringify({
            event: `orca_${this.service}_postgres_transaction_retry`,
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

  afterCommit(): void {
    throw new Error('after_commit_requires_transaction')
  }

  async close(): Promise<void> {
    await this.pool.end()
  }
}

// SQLite has no ADD COLUMN IF NOT EXISTS or DROP COLUMN IF EXISTS: run each plain, only while the
// column is missing or present.
async function applySchema(database: CloudDatabase, statements: string[]): Promise<void> {
  for (const statement of statements) {
    const target = schemaLockTarget(statement)
    if (target?.kind !== 'column') {
      await database.query(statement)
      continue
    }
    // SQLite names: quotes stripped, compared without case.
    const [present] = await database.query(
      'SELECT 1 FROM pragma_table_info(?) WHERE lower(name) = lower(?)',
      [target.table.replace(/^"|"$/g, ''), target.name.replace(/^"|"$/g, '')]
    )
    if (Boolean(present) === (target.skipWhen === 'absent')) {
      await database.query(
        statement
          .replace(/\bADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\b/i, 'ADD COLUMN')
          .replace(/\bDROP\s+COLUMN\s+IF\s+EXISTS\b/i, 'DROP COLUMN')
      )
    }
  }
}

// DDL may outlast request statement_timeout; apply once on a separate untimed connection, closed before serving, or every startup repeats the failure.
async function applySchemaOnUntimedPool(
  databaseUrl: string,
  { applicationName, service, schemaStatements, migrationOwner }: OpenCloudDatabaseInput
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
  absorbPostgresClientErrors(pool, service)
  const database = new PostgresDatabase(pool, service)
  try {
    if (!migrationOwner) {
      await applyPostgresSchema(schemaStatements, (statement) => database.query(statement), {
        eventPrefix: `orca_${service}_postgres_schema`,
        // No catalog pre-check: lock timeout cannot prove DDL already exists, so retain bounded retry.
        retryLockTimeout: true
      })
      return
    }
    const client = await pool.connect()
    try {
      await applyOwnedPostgresSchema({
        session: new PostgresTransaction(client),
        transaction: (operation) => runClientTransaction(client, operation),
        service,
        schemaStatements,
        lockTimeoutMs: POSTGRES_LOCK_TIMEOUT_MS,
        ...migrationOwner
      })
    } finally {
      client.release()
    }
  } finally {
    await database.close().catch(() => undefined)
  }
}

export function absorbPostgresClientErrors(pool: Pick<pg.Pool, 'on'>, service: string): void {
  pool.on('error', () => {
    // Handle idle pg errors after the pool removes failed clients; otherwise transient SQL faults crash-loop the service.
    console.warn(`[orca-${service}] idle PostgreSQL client failed`)
  })
  // The pool's own listener is off while a client is checked out, so a session Postgres ends mid-use
  // (an idle-in-transaction timeout, a proxy reset) would throw an unhandled 'error' and kill the
  // process. Each client listens from its first connect; the failed client is then unqueryable, and
  // its release destroys it.
  pool.on('connect', (client) => {
    client.on('error', (error) => {
      // Past the handshake, so its error carries no connection string.
      console.warn(
        `[orca-${service}] PostgreSQL client failed: ${String((error as { code?: unknown }).code)} ${error.message}`
      )
    })
  })
}

export type OpenCloudDatabaseInput = {
  // Names the SQLite file and every log event, e.g. 'push' -> orca-push.sqlite, orca_push_postgres_*.
  service: string
  schemaStatements: string[]
  databaseUrl?: string
  dataDir: string
  poolMax?: number
  applicationName?: string
  readOnly?: boolean
  // Postgres only: boots take turns under one migration lock; each runs beforeSchema, skips DDL the
  // catalog already has, and runs each data statement once per database.
  migrationOwner?: { beforeSchema?: (transaction: CloudDatabase) => Promise<void> }
}

export async function openCloudDatabase(input: OpenCloudDatabaseInput): Promise<CloudDatabase> {
  let database: CloudDatabase
  if (input.databaseUrl) {
    if (!input.readOnly) {
      await applySchemaOnUntimedPool(input.databaseUrl, input)
    }
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
    absorbPostgresClientErrors(pool, input.service)
    database = new PostgresDatabase(pool, input.service)
  } else {
    mkdirSync(input.dataDir, { recursive: true })
    const sqlite = new DatabaseSync(join(input.dataDir, `orca-${input.service}.sqlite`), {
      readOnly: input.readOnly ?? false
    })
    if (!input.readOnly) {
      sqlite.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
    }
    database = new SqliteDatabase(sqlite)
  }
  if (database.dialect === 'postgres' || input.readOnly) {
    return database
  }
  try {
    await applySchema(database, input.schemaStatements)
    return database
  } catch (error) {
    await database.close().catch(() => undefined)
    throw error
  }
}

export async function openInMemoryCloudDatabase(
  schemaStatements: string[]
): Promise<CloudDatabase> {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA foreign_keys = ON;')
  const database = new SqliteDatabase(sqlite)
  await applySchema(database, schemaStatements)
  return database
}

// The relay's RelayDatabase interface over Hyperdrive, so the credential store runs unchanged.
// Mirrors cloud/apps/relay/src/database/database.ts PostgresDatabase where the store depends on it:
// `?` placeholders become $n, writes without RETURNING answer [{ changes }], transactions retry
// serialization/deadlock/lock/statement-timeout aborts up to 3 times on a fresh connection.
// Hyperdrive pools connections to the origin, so each operation opens a short-lived client (the
// pattern Hyperdrive expects); nothing is held across requests, which keeps objects hibernatable.
import { Client } from 'pg'
import type {
  RelayDatabase,
  RelayLockOptions,
  RelayTransactionOptions,
  SqlRow
} from '../../relay/src/database/database'

const TRANSACTION_ATTEMPTS = 3
const RETRY_MAX_DELAY_MS = 25
const CONNECT_TIMEOUT_MS = 2_000
const QUERY_TIMEOUT_MS = 5_000

function postgresSql(sql: string): string {
  let index = 0
  return sql.replace(/\?/g, () => `$${++index}`)
}

function returnsRows(sql: string): boolean {
  return /^\s*(select|with)/i.test(sql) || /returning/i.test(sql)
}

function lockedStatement(sql: string, options: RelayLockOptions): string {
  if (options.lockClauseInStatement) { return sql }
  return `${sql} FOR UPDATE${options.failIfUnavailable ? ' NOWAIT' : ''}`
}

function sqlState(error: unknown): string {
  return String((error as { code?: unknown } | null)?.code)
}

function retryableTransactionError(error: unknown): boolean {
  return ['40P01', '40001', '55P03', '57014'].includes(sqlState(error))
}

// Same classification as the cells' isRelayDatabaseTransientError: callers answer 4429/4503 (or
// control-error database_transient), never a credential rejection.
const TRANSIENT_STATES = new Set([
  '40P01', '40001', '55P03', '57014', '53300', '57P03', '08000', '08001', '08003', '08006',
  '57P01', '57P02', '25P03'
])

export function isEdgeDatabaseTransientError(error: unknown): boolean {
  if (error instanceof EdgeDatabaseError) { return true }
  const code = sqlState(error)
  if (TRANSIENT_STATES.has(code) || code === 'ECONNRESET' || code === 'EPIPE' || code === 'ECONNREFUSED') {
    return true
  }
  const message = error instanceof Error ? error.message : ''
  return /^Connection terminated|timeout|connect/i.test(message)
}

// Wraps connection failures so they are recognisably the database's, without the URL in the text.
export class EdgeDatabaseError extends Error {
  constructor(readonly cause: unknown) {
    super('database_unavailable')
  }
}

async function run(client: Client, sql: string, params: unknown[]): Promise<SqlRow[]> {
  const result = await client.query({ text: postgresSql(sql), values: params })
  return returnsRows(sql) ? (result.rows as SqlRow[]) : [{ changes: result.rowCount ?? 0 }]
}

class EdgeTransaction implements RelayDatabase {
  readonly dialect = 'postgres' as const
  constructor(private readonly client: Client) {}

  query(sql: string, params: unknown[] = []): Promise<SqlRow[]> {
    return run(this.client, sql, params)
  }

  async queryLocked(sql: string, params: unknown[] = [], options: RelayLockOptions = {}): Promise<SqlRow[]> {
    try {
      return await run(this.client, lockedStatement(sql, options), params)
    } catch (error) {
      if (options.failIfUnavailable && sqlState(error) === '55P03') { throw new Error('database_lock_unavailable') }
      throw error
    }
  }

  async transaction<T>(operation: (transaction: RelayDatabase) => Promise<T>): Promise<T> {
    return await operation(this)
  }

  async close(): Promise<void> {}
}

export class EdgePostgresDatabase implements RelayDatabase {
  readonly dialect = 'postgres' as const

  constructor(
    private readonly connectionString: string,
    // Called once per operation with its wall time and outcome (metrics; must not throw).
    private readonly onOp: (ms: number, outcome: 'ok' | 'transient' | 'error') => void = () => {}
  ) {}

  private async timed<T>(operation: () => Promise<T>): Promise<T> {
    const started = Date.now()
    try {
      const result = await operation()
      this.onOp(Date.now() - started, 'ok')
      return result
    } catch (error) {
      this.onOp(Date.now() - started, isEdgeDatabaseTransientError(error) ? 'transient' : 'error')
      throw error
    }
  }

  private async connect(): Promise<Client> {
    const client = new Client({
      connectionString: this.connectionString,
      connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
      query_timeout: QUERY_TIMEOUT_MS
    })
    // An idle client error after end() must not become an unhandled rejection.
    client.on('error', () => {})
    try {
      await client.connect()
    } catch (error) {
      await client.end().catch(() => {})
      throw new EdgeDatabaseError(error)
    }
    return client
  }

  query(sql: string, params: unknown[] = []): Promise<SqlRow[]> {
    return this.timed(async () => {
      const client = await this.connect()
      try {
        return await run(client, sql, params)
      } finally {
        await client.end().catch(() => {})
      }
    })
  }

  async queryLocked(sql: string, params: unknown[] = [], options: RelayLockOptions = {}): Promise<SqlRow[]> {
    try {
      return await this.query(lockedStatement(sql, options), params)
    } catch (error) {
      if (options.failIfUnavailable && sqlState(error) === '55P03') { throw new Error('database_lock_unavailable') }
      throw error
    }
  }

  async transaction<T>(
    operation: (transaction: RelayDatabase) => Promise<T>,
    _options: RelayTransactionOptions = {}
  ): Promise<T> {
    return this.timed(() => this.runTransaction(operation))
  }

  private async runTransaction<T>(operation: (transaction: RelayDatabase) => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      const client = await this.connect()
      let begun = false
      try {
        await client.query('BEGIN')
        begun = true
        const result = await operation(new EdgeTransaction(client))
        await client.query('COMMIT')
        return result
      } catch (error) {
        if (begun) { await client.query('ROLLBACK').catch(() => {}) }
        if (!retryableTransactionError(error) || attempt >= TRANSACTION_ATTEMPTS) { throw error }
      } finally {
        await client.end().catch(() => {})
      }
      await new Promise((resolve) => setTimeout(resolve, Math.random() * RETRY_MAX_DELAY_MS))
    }
  }

  async close(): Promise<void> {}
}

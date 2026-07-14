import { Client, type ClientConfig, type FieldDef, type QueryResult } from 'pg'
import Cursor from 'pg-cursor'
import type {
  DatabaseCellValue,
  DatabaseConnectionConfig,
  DatabaseConnectionRequest,
  DatabaseConnectionTestResult,
  DatabaseQueryRequest,
  DatabaseQueryResult,
  DatabaseSchemaResult
} from '../../shared/database-types'
import type { DatabaseProvider } from './database-provider'

type ActiveQuery = {
  client: Client
  clientConfig: ClientConfig
  cursor: Cursor<unknown[]> | null
  backendPid: number | null
  cancelPromise: Promise<boolean> | null
}

type CursorReadResult = {
  rows: unknown[][]
  result: QueryResult<unknown[]>
}

const MAX_CONNECTION_TIMEOUT_MS = 30_000
const MAX_QUERY_TIMEOUT_MS = 300_000
const MAX_QUERY_ROWS = 10_000
const MAX_SCHEMA_COLUMNS = 50_000

function toClientConfig(
  connection: DatabaseConnectionConfig,
  password: string | undefined
): ClientConfig {
  const ssl =
    connection.sslMode === 'disable'
      ? false
      : {
          rejectUnauthorized: connection.sslMode === 'verify-full',
          ...(connection.tlsServerName ? { servername: connection.tlsServerName } : {})
        }
  return {
    host: connection.host,
    port: connection.port,
    database: connection.database,
    user: connection.user,
    password,
    ssl,
    connectionTimeoutMillis: MAX_CONNECTION_TIMEOUT_MS,
    statement_timeout: MAX_CONNECTION_TIMEOUT_MS,
    query_timeout: MAX_CONNECTION_TIMEOUT_MS + 5_000,
    application_name: 'orca-database-tab'
  }
}

function normalizeCell(value: unknown): DatabaseCellValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : String(value)
  }
  if (typeof value === 'bigint') {
    return value.toString()
  }
  if (value instanceof Date) {
    return value.toISOString()
  }
  if (Buffer.isBuffer(value)) {
    return `<binary ${value.byteLength} bytes>`
  }
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function readCursor(cursor: Cursor<unknown[]>, maxRows: number): Promise<CursorReadResult> {
  return new Promise((resolve, reject) => {
    cursor.read(maxRows, (error, rows, result) => {
      if (error) {
        reject(error)
        return
      }
      resolve({ rows, result: result as QueryResult<unknown[]> })
    })
  })
}

function addAbortHandler(signal: AbortSignal | undefined, cancel: () => void): () => void {
  if (!signal) {
    return () => {}
  }
  if (signal.aborted) {
    cancel()
    return () => {}
  }
  signal.addEventListener('abort', cancel, { once: true })
  return () => signal.removeEventListener('abort', cancel)
}

function mapFields(fields: FieldDef[]): DatabaseQueryResult['columns'] {
  return fields.map((field) => ({ name: field.name, dataTypeId: field.dataTypeID }))
}

export class PostgresProvider implements DatabaseProvider {
  readonly id = 'postgres' as const
  private readonly activeQueries = new Map<string, ActiveQuery>()

  async testConnection(
    request: DatabaseConnectionRequest,
    signal?: AbortSignal
  ): Promise<DatabaseConnectionTestResult> {
    const client = new Client(
      toClientConfig(request.connection, request.credential.password || undefined)
    )
    const removeAbort = addAbortHandler(signal, () => void client.end())
    try {
      await client.connect()
      const result = await client.query<{ database: string; server_version: string }>(
        "SELECT current_database() AS database, current_setting('server_version') AS server_version"
      )
      const row = result.rows[0]
      return {
        database: row?.database ?? request.connection.database,
        serverVersion: row?.server_version ?? 'unknown'
      }
    } finally {
      removeAbort()
      await client.end().catch(() => {})
    }
  }

  async introspect(
    request: DatabaseConnectionRequest,
    signal?: AbortSignal
  ): Promise<DatabaseSchemaResult> {
    const client = new Client(
      toClientConfig(request.connection, request.credential.password || undefined)
    )
    const removeAbort = addAbortHandler(signal, () => void client.end())
    try {
      await client.connect()
      const result = await client.query<{
        table_schema: string
        table_name: string
        column_name: string
        data_type: string
        is_nullable: 'YES' | 'NO'
        column_default: string | null
      }>(
        `SELECT table_schema, table_name, column_name, data_type, is_nullable, column_default
           FROM information_schema.columns
          WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
          ORDER BY table_schema, table_name, ordinal_position
          LIMIT ${MAX_SCHEMA_COLUMNS}`
      )
      const tables = new Map<string, DatabaseSchemaResult['tables'][number]>()
      for (const row of result.rows) {
        const key = `${row.table_schema}\0${row.table_name}`
        let table = tables.get(key)
        if (!table) {
          table = { schema: row.table_schema, name: row.table_name, columns: [] }
          tables.set(key, table)
        }
        table.columns.push({
          name: row.column_name,
          dataType: row.data_type,
          nullable: row.is_nullable === 'YES',
          defaultValue: row.column_default
        })
      }
      return { tables: [...tables.values()] }
    } finally {
      removeAbort()
      await client.end().catch(() => {})
    }
  }

  async execute(request: DatabaseQueryRequest, signal?: AbortSignal): Promise<DatabaseQueryResult> {
    if (this.activeQueries.has(request.queryId)) {
      throw new Error('A query with this id is already running')
    }
    const clientConfig = toClientConfig(
      request.connection,
      request.credential.password || undefined
    )
    const client = new Client(clientConfig)
    const active: ActiveQuery = {
      client,
      clientConfig,
      cursor: null,
      backendPid: null,
      cancelPromise: null
    }
    this.activeQueries.set(request.queryId, active)
    const removeAbort = addAbortHandler(signal, () => void this.cancel(request.queryId))
    const startedAt = performance.now()
    // Why: RPC validation already bounds these values, but the provider is also
    // callable in-process and must not turn a malformed internal call into an
    // unbounded cursor read or statement timeout.
    const maxRows = Math.max(1, Math.min(MAX_QUERY_ROWS, Math.trunc(request.maxRows)))
    const timeoutMs = Math.max(100, Math.min(MAX_QUERY_TIMEOUT_MS, Math.trunc(request.timeoutMs)))
    let transactionOpen = false
    try {
      await client.connect()
      active.backendPid = (client as Client & { processID?: number }).processID ?? null
      await client.query(request.readOnly ? 'BEGIN READ ONLY' : 'BEGIN')
      transactionOpen = true
      await client.query(`SET LOCAL statement_timeout = ${timeoutMs}`)

      const cursor = client.query(
        new Cursor<unknown[]>(request.sql, [], {
          rowMode: 'array'
        })
      )
      active.cursor = cursor
      const readResult = await readCursor(cursor, maxRows + 1)
      const truncated = readResult.rows.length > maxRows
      const visibleRows = truncated ? readResult.rows.slice(0, maxRows) : readResult.rows
      await cursor.close()
      active.cursor = null
      await client.query('COMMIT')
      transactionOpen = false
      return {
        columns: mapFields(readResult.result.fields),
        rows: visibleRows.map((row) => row.map(normalizeCell)),
        command: readResult.result.command,
        rowCount: readResult.result.rowCount,
        truncated,
        durationMs: Math.max(0, Math.round(performance.now() - startedAt))
      }
    } catch (error) {
      if (transactionOpen) {
        await client.query('ROLLBACK').catch(() => {})
      }
      throw error
    } finally {
      removeAbort()
      this.activeQueries.delete(request.queryId)
      await client.end().catch(() => {})
    }
  }

  async cancel(queryId: string): Promise<boolean> {
    const active = this.activeQueries.get(queryId)
    if (!active) {
      return false
    }
    active.cancelPromise ??= this.cancelActiveQuery(active)
    return active.cancelPromise
  }

  private async cancelActiveQuery(active: ActiveQuery): Promise<boolean> {
    // Why: closing a busy pg-cursor is serialized behind the query that it is
    // meant to stop, so awaiting cursor.close() makes the cancel RPC hang until
    // the statement finishes. PostgreSQL's cancellation function runs through
    // a second short-lived connection and interrupts the target backend while
    // leaving its connection usable for the execute path to roll back cleanly.
    if (active.backendPid === null) {
      void active.client.end().catch(() => {})
      return true
    }
    const cancelClient = new Client({
      ...active.clientConfig,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 5_000,
      query_timeout: 7_000,
      application_name: 'orca-database-tab-cancel'
    })
    try {
      await cancelClient.connect()
      const result = await cancelClient.query<{ canceled: boolean }>(
        'SELECT pg_cancel_backend($1) AS canceled',
        [active.backendPid]
      )
      return result.rows[0]?.canceled === true
    } finally {
      await cancelClient.end().catch(() => {})
    }
  }
}

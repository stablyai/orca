// Postgres driver: lazy-imports `pg` on first use (kept out of the startup
// require-graph), dials over a small pool with a bounded connect timeout, and
// attaches the mandatory pool 'error' listener so a dropped idle client degrades
// to `lost` instead of crashing the main process.

import {
  applyCap,
  DB_CONNECT_TIMEOUT_MS,
  DB_STATEMENT_TIMEOUT_MS,
  raceWithTimeout,
  type DbDriver,
  type LiveConnection,
  type ResolvedDbConfig,
  type ResolvedSslMode
} from './db-driver'
import {
  mapColumnRows,
  mapSchemaRows,
  mapTableRows,
  PG_COLUMNS_SQL,
  PG_SCHEMAS_SQL,
  PG_TABLES_SQL
} from './postgres-introspection-queries'
import {
  cancelPostgresBackend,
  runPostgresBatch,
  runPostgresExecute,
  runPostgresQuery
} from './postgres-query'
import type {
  DbColumn,
  DbSchemaTree,
  DbStatement,
  DbTableList,
  DbTableRef,
  QueryHandle,
  QueryOptions,
  QueryResult
} from '../../shared/database-types'
import type { Client, ClientConfig, Pool, PoolConfig } from 'pg'

// Why: 1 query connection + 1 introspection connection so introspect (P4) and
// query (P5) don't serialize on a single socket (red-team F11). Kept small to
// bound the server-side backend count.
const POOL_MAX = 2
const POOL_IDLE_TIMEOUT_MS = 30_000

// disable → no TLS. verify-full → TLS with cert + hostname verification.
// insecure-no-verify → TLS without verification (explicit opt-in only).
export function buildPgSsl(ssl: ResolvedSslMode): PoolConfig['ssl'] {
  if (ssl === 'disable') {
    return false
  }
  return { rejectUnauthorized: ssl === 'verify-full' }
}

// Connection-level config, shared by the pool and the short-lived cancel client.
export function buildPgClientConfig(cfg: ResolvedDbConfig): ClientConfig {
  return {
    host: cfg.host,
    port: cfg.port,
    database: cfg.database,
    user: cfg.user,
    password: cfg.password,
    ssl: buildPgSsl(cfg.ssl),
    connectionTimeoutMillis: DB_CONNECT_TIMEOUT_MS,
    // Red-team M2: bound every statement on the connection (introspection +
    // validate), not just connect. The query path re-SETs this per transaction.
    statement_timeout: DB_STATEMENT_TIMEOUT_MS
  }
}

export function buildPgPoolConfig(cfg: ResolvedDbConfig): PoolConfig {
  return {
    ...buildPgClientConfig(cfg),
    max: POOL_MAX,
    idleTimeoutMillis: POOL_IDLE_TIMEOUT_MS
  }
}

// pg is CommonJS; interop may hand back the module under `.default`.
type PgModule = {
  Pool: new (config?: PoolConfig) => Pool
  Client: new (config?: ClientConfig) => Client
}
async function loadPg(): Promise<PgModule> {
  const mod = (await import('pg')) as unknown as PgModule & { default?: PgModule }
  return mod.default ?? mod
}

async function validatePool(pool: Pool): Promise<void> {
  const client = await raceWithTimeout(pool.connect(), DB_CONNECT_TIMEOUT_MS)
  try {
    await client.query('SELECT 1')
  } finally {
    client.release()
  }
}

export const postgresDriver: DbDriver = {
  async testConnection(cfg: ResolvedDbConfig): Promise<void> {
    const pg = await loadPg()
    const pool = new pg.Pool(buildPgPoolConfig(cfg))
    // Why: even a throwaway test pool is an EventEmitter — an 'error' with no
    // listener re-throws and crashes the process.
    pool.on('error', () => {})
    try {
      await validatePool(pool)
    } finally {
      await pool.end().catch(() => {})
    }
  },

  async connect(
    cfg: ResolvedDbConfig,
    onError: (err: unknown) => void
  ): Promise<LiveConnection> {
    const pg = await loadPg()
    const pool = new pg.Pool(buildPgPoolConfig(cfg))
    // Red-team F4 (Critical): a pooled idle client whose socket drops emits
    // 'error' on the pool; unhandled, it crashes every PTY/SSH/terminal.
    pool.on('error', (err) => onError(err))
    try {
      await validatePool(pool)
    } catch (err) {
      await pool.end().catch(() => {})
      throw err
    }
    return { id: cfg.id, engine: 'postgres', raw: pool, config: cfg }
  },

  async introspectSchemas(conn: LiveConnection, maxSchemas: number): Promise<DbSchemaTree> {
    // Query cap+1 so an overflow beyond the cap is detectable (red-team F9).
    const result = await (conn.raw as Pool).query(PG_SCHEMAS_SQL, [maxSchemas + 1])
    const { kept, truncated } = applyCap(mapSchemaRows(result.rows), maxSchemas)
    return { schemas: kept, truncated }
  },

  async introspectTables(
    conn: LiveConnection,
    schema: string,
    maxTables: number
  ): Promise<DbTableList> {
    const result = await (conn.raw as Pool).query(PG_TABLES_SQL, [schema, maxTables + 1])
    const { kept, truncated } = applyCap(mapTableRows(result.rows), maxTables)
    return { tables: kept, truncated }
  },

  async introspectColumns(conn: LiveConnection, ref: DbTableRef): Promise<DbColumn[]> {
    const result = await (conn.raw as Pool).query(PG_COLUMNS_SQL, [ref.schema, ref.table])
    return mapColumnRows(result.rows)
  },

  query(
    conn: LiveConnection,
    sql: string,
    opts: QueryOptions,
    onStart: (handle: QueryHandle) => void
  ): Promise<QueryResult> {
    return runPostgresQuery(conn.raw as Pool, conn.id, sql, opts, onStart)
  },

  execute(
    conn: LiveConnection,
    statement: DbStatement,
    opts: QueryOptions,
    onStart: (handle: QueryHandle) => void
  ): Promise<QueryResult> {
    return runPostgresExecute(conn.raw as Pool, conn.id, statement, opts, onStart)
  },

  executeBatch(
    conn: LiveConnection,
    statements: DbStatement[],
    opts: QueryOptions,
    onStart: (handle: QueryHandle) => void
  ): Promise<number[]> {
    return runPostgresBatch(conn.raw as Pool, conn.id, statements, opts, onStart)
  },

  async cancel(conn: LiveConnection, handle: QueryHandle): Promise<void> {
    if (handle.backendPid == null) {
      return
    }
    const pg = await loadPg()
    await cancelPostgresBackend(
      new pg.Client(buildPgClientConfig(conn.config)),
      handle.backendPid
    )
  },

  async close(conn: LiveConnection): Promise<void> {
    await (conn.raw as Pool).end()
  }
}

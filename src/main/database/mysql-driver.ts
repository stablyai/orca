// MySQL driver: lazy-imports `mysql2/promise` on first use, dials over a small
// pool with a bounded connect timeout, disables the client-side LOCAL INFILE and
// multi-statement vectors, and forwards pooled-connection 'error' events so a
// dropped connection degrades to `lost` instead of crashing the main process.

import {
  applyCap,
  DB_CONNECT_TIMEOUT_MS,
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
  MYSQL_COLUMNS_SQL,
  MYSQL_SCHEMAS_SQL,
  MYSQL_TABLES_SQL
} from './mysql-introspection-queries'
import type { DbColumn, DbSchemaTree, DbTableList, DbTableRef } from '../../shared/database-types'
import type { Pool, PoolOptions, RowDataPacket } from 'mysql2/promise'

// 1 query + 1 introspection connection (red-team F11); small to bound backends.
const POOL_MAX = 2
const POOL_IDLE_TIMEOUT_MS = 30_000

// disable → no TLS. verify-full → verify cert chain. insecure-no-verify → TLS
// without verification (explicit opt-in only).
export function buildMysqlSsl(ssl: ResolvedSslMode): PoolOptions['ssl'] {
  if (ssl === 'disable') {
    return undefined
  }
  return { rejectUnauthorized: ssl === 'verify-full' }
}

export function buildMysqlPoolConfig(cfg: ResolvedDbConfig): PoolOptions {
  return {
    host: cfg.host,
    port: cfg.port,
    database: cfg.database,
    user: cfg.user,
    password: cfg.password,
    ssl: buildMysqlSsl(cfg.ssl),
    connectTimeout: DB_CONNECT_TIMEOUT_MS,
    connectionLimit: POOL_MAX,
    idleTimeout: POOL_IDLE_TIMEOUT_MS,
    // Red-team F7: mysql2 keeps LOCAL INFILE (client file-read) disabled unless a
    // stream factory is supplied — pin it undefined so the vector stays closed.
    infileStreamFactory: undefined,
    // Red-team F3/F7: single-statement only — the write guard and cancel logic
    // both assume one statement per query; multi-statement would bypass them.
    multipleStatements: false
  }
}

// mysql2/promise is CommonJS; interop may hand back the module under `.default`.
// The core (callback) pool is reachable via `.pool` for the 'connection' event.
type MysqlPool = Pool & { pool?: { on(event: 'connection', cb: (c: unknown) => void): void } }
type MysqlModule = { createPool: (config: PoolOptions) => MysqlPool }
async function loadMysql(): Promise<MysqlModule> {
  const mod = (await import('mysql2/promise')) as unknown as MysqlModule & {
    default?: MysqlModule
  }
  return mod.default ?? mod
}

async function validatePool(pool: Pool): Promise<void> {
  const conn = await raceWithTimeout(pool.getConnection(), DB_CONNECT_TIMEOUT_MS)
  try {
    await conn.query('SELECT 1')
  } finally {
    conn.release()
  }
}

// Attach an 'error' listener to every pooled connection. mysql2 pools remove a
// broken connection internally, but the connection is still an EventEmitter — an
// 'error' with no listener re-throws and crashes the process (red-team F4).
function wireConnectionErrors(pool: MysqlPool, onError: (err: unknown) => void): void {
  pool.pool?.on('connection', (conn) => {
    const emitter = conn as { on?: (event: 'error', cb: (err: unknown) => void) => void }
    emitter.on?.('error', (err) => onError(err))
  })
}

export const mysqlDriver: DbDriver = {
  async testConnection(cfg: ResolvedDbConfig): Promise<void> {
    const mysql = await loadMysql()
    const pool = mysql.createPool(buildMysqlPoolConfig(cfg))
    wireConnectionErrors(pool, () => {})
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
    const mysql = await loadMysql()
    const pool = mysql.createPool(buildMysqlPoolConfig(cfg))
    wireConnectionErrors(pool, onError)
    try {
      await validatePool(pool)
    } catch (err) {
      await pool.end().catch(() => {})
      throw err
    }
    return { id: cfg.id, engine: 'mysql', raw: pool }
  },

  async introspectSchemas(conn: LiveConnection, maxSchemas: number): Promise<DbSchemaTree> {
    // Query cap+1 so an overflow beyond the cap is detectable (red-team F9).
    const [rows] = await (conn.raw as Pool).query<RowDataPacket[]>(MYSQL_SCHEMAS_SQL, [
      maxSchemas + 1
    ])
    const { kept, truncated } = applyCap(mapSchemaRows(rows as { name: string }[]), maxSchemas)
    return { schemas: kept, truncated }
  },

  async introspectTables(
    conn: LiveConnection,
    schema: string,
    maxTables: number
  ): Promise<DbTableList> {
    const [rows] = await (conn.raw as Pool).query<RowDataPacket[]>(MYSQL_TABLES_SQL, [
      schema,
      maxTables + 1
    ])
    const { kept, truncated } = applyCap(
      mapTableRows(rows as { name: string; type: string }[]),
      maxTables
    )
    return { tables: kept, truncated }
  },

  async introspectColumns(conn: LiveConnection, ref: DbTableRef): Promise<DbColumn[]> {
    const [rows] = await (conn.raw as Pool).query<RowDataPacket[]>(MYSQL_COLUMNS_SQL, [
      ref.schema,
      ref.table
    ])
    return mapColumnRows(
      rows as { name: string; data_type: string; is_nullable: string; column_key: string }[]
    )
  },

  async close(conn: LiveConnection): Promise<void> {
    await (conn.raw as Pool).end()
  }
}

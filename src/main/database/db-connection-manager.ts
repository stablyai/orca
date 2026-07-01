// Owns live database connections with full lifecycle resilience: a connect-race
// guard, a driver 'error' listener that degrades a dropped connection to `lost`
// (never crashing the main process), and quit-time disposal. Mirrors
// ssh-connection-manager's pool/guard shape; drivers lazy-import pg/mysql2.

import type {
  DbColumn,
  DbConnectionRuntimeState,
  DbEngine,
  DbSchemaTree,
  DbStatement,
  DbTableList,
  DbTableRef,
  QueryHandle,
  QueryOptions,
  QueryResult
} from '../../shared/database-types'
import {
  DB_MAX_SCHEMAS,
  DB_MAX_TABLES_PER_SCHEMA,
  normalizeDbError,
  type DbDriver,
  type LiveConnection,
  type ResolvedDbConfig
} from './db-driver'
import { isMultiStatement } from '../../shared/sql-statement-classifier'
import { postgresDriver } from './postgres-driver'
import { mysqlDriver } from './mysql-driver'

function getDriver(engine: DbEngine): DbDriver {
  return engine === 'postgres' ? postgresDriver : mysqlDriver
}

type StatusListener = (state: DbConnectionRuntimeState) => void

export class DbConnectionManager {
  private connections = new Map<string, LiveConnection>()
  private statuses = new Map<string, DbConnectionRuntimeState>()
  // Backend PID of the query currently running on each connection, so a cancel
  // request can target the right server-side query.
  private inFlight = new Map<string, QueryHandle>()
  // Why: two concurrent connect(sameId) calls would both create a pool and orphan
  // the first — this guard rejects the second while one is in progress (SSH F12).
  private connectingTargets = new Set<string>()
  private statusListener: StatusListener = () => {}

  setStatusListener(listener: StatusListener): void {
    this.statusListener = listener
  }

  private setStatus(
    id: string,
    status: DbConnectionRuntimeState['status'],
    error?: DbConnectionRuntimeState['error']
  ): void {
    const state: DbConnectionRuntimeState = error ? { id, status, error } : { id, status }
    this.statuses.set(id, state)
    this.statusListener(state)
  }

  getStatus(id: string): DbConnectionRuntimeState {
    return this.statuses.get(id) ?? { id, status: 'idle' }
  }

  getAllStatuses(): DbConnectionRuntimeState[] {
    return Array.from(this.statuses.values())
  }

  getConnection(id: string): LiveConnection | undefined {
    return this.connections.get(id)
  }

  // One-shot ping; holds no state and never touches the live-connection map.
  async test(cfg: ResolvedDbConfig): Promise<void> {
    await getDriver(cfg.engine).testConnection(cfg)
  }

  async connect(cfg: ResolvedDbConfig): Promise<DbConnectionRuntimeState> {
    if (this.connections.has(cfg.id)) {
      return this.getStatus(cfg.id)
    }
    if (this.connectingTargets.has(cfg.id)) {
      throw new Error('db_connect_in_progress')
    }
    this.connectingTargets.add(cfg.id)
    this.setStatus(cfg.id, 'connecting')
    // Bind the driver's 'error' listener to this specific connection: a late
    // error from a pool that was disconnected/reconnected must not tear down the
    // live connection that replaced it under the same id.
    let liveConn: LiveConnection | null = null
    try {
      const conn = await getDriver(cfg.engine).connect(cfg, (err) => {
        if (liveConn && this.connections.get(cfg.id) === liveConn) {
          this.handleConnectionError(cfg.id, err)
        }
      })
      liveConn = conn
      this.connections.set(cfg.id, conn)
      this.setStatus(cfg.id, 'connected')
      return this.getStatus(cfg.id)
    } catch (err) {
      this.setStatus(cfg.id, 'error', normalizeDbError(err))
      throw err
    } finally {
      this.connectingTargets.delete(cfg.id)
    }
  }

  // Red-team F4: driver 'error' after a live connection drops. Mark lost, drop
  // it from the map, and close it in the background — never re-throw (that would
  // crash the process and kill every PTY/SSH/terminal).
  private handleConnectionError(id: string, err: unknown): void {
    const conn = this.connections.get(id)
    this.connections.delete(id)
    // Drop any in-flight handle: a reconnect under this id must not inherit the
    // dead query's backend PID (cancel would target the wrong backend) or trip
    // the concurrency guard against a query that can no longer settle.
    this.inFlight.delete(id)
    this.setStatus(id, 'lost', normalizeDbError(err))
    if (conn) {
      void getDriver(conn.engine)
        .close(conn)
        .catch(() => {})
    }
  }

  // Why: introspection needs a held connection. Throw a fixed code (mapped to a
  // safe message at the IPC boundary) rather than dereferencing undefined.
  private requireLive(id: string): LiveConnection {
    const conn = this.connections.get(id)
    if (!conn) {
      throw new Error('db_not_connected')
    }
    return conn
  }

  // async so the requireLive guard surfaces as a rejection, not a sync throw.
  async introspectSchemas(id: string): Promise<DbSchemaTree> {
    const conn = this.requireLive(id)
    return getDriver(conn.engine).introspectSchemas(conn, DB_MAX_SCHEMAS)
  }

  async introspectTables(id: string, schema: string): Promise<DbTableList> {
    const conn = this.requireLive(id)
    return getDriver(conn.engine).introspectTables(conn, schema, DB_MAX_TABLES_PER_SCHEMA)
  }

  async introspectColumns(id: string, ref: DbTableRef): Promise<DbColumn[]> {
    const conn = this.requireLive(id)
    return getDriver(conn.engine).introspectColumns(conn, ref)
  }

  async query(id: string, sql: string, opts: QueryOptions): Promise<QueryResult> {
    const conn = this.requireLive(id)
    // L3: one query per connection at a time — a second concurrent query would
    // overwrite the in-flight handle and make cancel target the wrong query.
    if (this.inFlight.has(id)) {
      throw new Error('db_query_in_progress')
    }
    // H1 (red-team): a read-only connection must reject multi-statement input.
    // A Postgres simple query runs every statement, so a multi-statement string
    // could flip `SET TRANSACTION READ WRITE` before any query and defeat the
    // read-only transaction. The DB read-only txn covers single-statement writes
    // and writing CTEs; this closes the multi-statement gap.
    if (!opts.allowWrite && isMultiStatement(sql)) {
      throw new Error('db_read_only_multi_statement')
    }
    // Reserve synchronously so the concurrency guard holds before the driver's
    // async backend-PID capture; onStart replaces this with the real handle.
    this.inFlight.set(id, { connectionId: id, backendPid: null })
    try {
      return await getDriver(conn.engine).query(conn, sql, opts, (handle) => {
        this.inFlight.set(id, handle)
      })
    } finally {
      this.inFlight.delete(id)
    }
  }

  // Parameterized single statement (Data-tab select/count or wrapped free-form
  // re-query). Shares the one-query-per-connection guard so cancel targets the
  // right backend and a concurrent op can't overwrite the in-flight handle.
  async execute(id: string, statement: DbStatement, opts: QueryOptions): Promise<QueryResult> {
    const conn = this.requireLive(id)
    if (this.inFlight.has(id)) {
      throw new Error('db_query_in_progress')
    }
    this.inFlight.set(id, { connectionId: id, backendPid: null })
    try {
      return await getDriver(conn.engine).execute(conn, statement, opts, (handle) => {
        this.inFlight.set(id, handle)
      })
    } finally {
      this.inFlight.delete(id)
    }
  }

  // Atomic staged-edit apply. Writes only: a read-only connection is rejected
  // here (defense in depth — the UI already disables editing on read-only).
  async executeBatch(id: string, statements: DbStatement[], opts: QueryOptions): Promise<number[]> {
    const conn = this.requireLive(id)
    if (!opts.allowWrite) {
      throw new Error('db_read_only_write_blocked')
    }
    if (this.inFlight.has(id)) {
      throw new Error('db_query_in_progress')
    }
    this.inFlight.set(id, { connectionId: id, backendPid: null })
    try {
      return await getDriver(conn.engine).executeBatch(conn, statements, opts, (handle) => {
        this.inFlight.set(id, handle)
      })
    } finally {
      this.inFlight.delete(id)
    }
  }

  // Cancel the in-flight query on a connection via the driver's side connection.
  // No-op if nothing is running or the backend PID was never captured.
  async cancelQuery(id: string): Promise<void> {
    const handle = this.inFlight.get(id)
    const conn = this.connections.get(id)
    if (!handle || !conn) {
      return
    }
    await getDriver(conn.engine).cancel(conn, handle)
  }

  async disconnect(id: string): Promise<void> {
    const conn = this.connections.get(id)
    this.connections.delete(id)
    this.inFlight.delete(id)
    this.setStatus(id, 'idle')
    if (conn) {
      await getDriver(conn.engine).close(conn)
    }
  }

  // Quit-time disposal (red-team F12): SSH's own manager is never disposed on
  // quit, so this must be wired explicitly into index.ts will-quit.
  async disconnectAll(): Promise<void> {
    const live = Array.from(this.connections.values())
    this.connections.clear()
    this.inFlight.clear()
    await Promise.allSettled(live.map((conn) => getDriver(conn.engine).close(conn)))
  }
}

// Single main-process instance shared by the IPC handlers and quit hook.
export const dbConnectionManager = new DbConnectionManager()

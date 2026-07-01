// Owns live database connections with full lifecycle resilience: a connect-race
// guard, a driver 'error' listener that degrades a dropped connection to `lost`
// (never crashing the main process), and quit-time disposal. Mirrors
// ssh-connection-manager's pool/guard shape; drivers lazy-import pg/mysql2.

import type {
  DbColumn,
  DbConnectionRuntimeState,
  DbEngine,
  DbSchemaTree,
  DbTableList,
  DbTableRef
} from '../../shared/database-types'
import {
  DB_MAX_SCHEMAS,
  DB_MAX_TABLES_PER_SCHEMA,
  normalizeDbError,
  type DbDriver,
  type LiveConnection,
  type ResolvedDbConfig
} from './db-driver'
import { postgresDriver } from './postgres-driver'
import { mysqlDriver } from './mysql-driver'

function getDriver(engine: DbEngine): DbDriver {
  return engine === 'postgres' ? postgresDriver : mysqlDriver
}

type StatusListener = (state: DbConnectionRuntimeState) => void

export class DbConnectionManager {
  private connections = new Map<string, LiveConnection>()
  private statuses = new Map<string, DbConnectionRuntimeState>()
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
    try {
      const conn = await getDriver(cfg.engine).connect(cfg, (err) =>
        this.handleConnectionError(cfg.id, err)
      )
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

  async disconnect(id: string): Promise<void> {
    const conn = this.connections.get(id)
    this.connections.delete(id)
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
    await Promise.allSettled(live.map((conn) => getDriver(conn.engine).close(conn)))
  }
}

// Single main-process instance shared by the IPC handlers and quit hook.
export const dbConnectionManager = new DbConnectionManager()

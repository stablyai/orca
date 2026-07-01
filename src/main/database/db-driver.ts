// Driver abstraction for the in-app database client. Postgres/MySQL drivers
// implement this interface with lazy (`await import`) module loading so pg/mysql2
// stay out of the main-process startup require-graph until the first connect.

import type {
  DbColumn,
  DbConnection,
  DbEngine,
  DbSafeError,
  DbSchemaTree,
  DbSslMode,
  DbTableList,
  DbTableRef,
  QueryHandle,
  QueryOptions,
  QueryResult
} from '../../shared/database-types'

// Mirrors SSH's readyTimeout (ssh-connection-utils CONNECT_TIMEOUT_MS): a dead
// host must never hang the IPC forever. pg's default is wait-forever.
export const DB_CONNECT_TIMEOUT_MS = 30_000

// Introspection caps (red-team F9): a level with more objects than its cap is
// returned truncated rather than buffering the whole catalog into main + IPC.
export const DB_MAX_SCHEMAS = 500
export const DB_MAX_TABLES_PER_SCHEMA = 2_000

// Query caps (red-team F9): a server-side cursor fetches at most DB_MAX_ROWS + 1
// so a huge result never buffers whole; the statement timeout bounds runtime.
export const DB_MAX_ROWS = 1_000
export const DB_STATEMENT_TIMEOUT_MS = 30_000

// SSL after smart-by-host resolution — always a concrete mode, never unset.
export type ResolvedSslMode = 'disable' | 'verify-full' | 'insecure-no-verify'

// Ready-to-dial config: password decrypted at point-of-use (never persisted in
// this shape) and SSL collapsed from smart-by-host to a concrete mode.
export type ResolvedDbConfig = {
  id: string
  engine: DbEngine
  host: string
  port: number
  database: string
  user: string
  password?: string
  ssl: ResolvedSslMode
  readOnly: boolean
}

// Opaque live handle held by the manager. `raw` is the driver-native pool; the
// driver attaches an 'error' listener (forwarding to the manager) before this is
// returned, so a dropped connection degrades to `lost` instead of crashing.
// `config` is retained so cancel can open a short-lived side connection to issue
// pg_cancel_backend / KILL QUERY without competing for a pooled slot.
export type LiveConnection = {
  id: string
  engine: DbEngine
  raw: unknown
  config: ResolvedDbConfig
}

export type DbDriver = {
  // Bounded by the connect timeout; throws on failure. Holds no state.
  testConnection(cfg: ResolvedDbConfig): Promise<void>
  // Pool-backed; attaches the mandatory 'error' listener before returning.
  connect(cfg: ResolvedDbConfig, onError: (err: unknown) => void): Promise<LiveConnection>
  // Lazy, capped introspection. Each runs on a pooled connection so it never
  // contends with a running query (red-team F11). Query/cancel come in Phase 5.
  introspectSchemas(conn: LiveConnection, maxSchemas: number): Promise<DbSchemaTree>
  introspectTables(
    conn: LiveConnection,
    schema: string,
    maxTables: number
  ): Promise<DbTableList>
  introspectColumns(conn: LiveConnection, ref: DbTableRef): Promise<DbColumn[]>
  // Runs SQL on a dedicated pooled connection: read-only DB transaction when
  // !allowWrite, statement timeout, cursor bounded to rowLimit+1. `onStart`
  // reports the backend PID so the query can be cancelled while running.
  query(
    conn: LiveConnection,
    sql: string,
    opts: QueryOptions,
    onStart: (handle: QueryHandle) => void
  ): Promise<QueryResult>
  // Server-side cancel via a short-lived side connection (pg_cancel_backend /
  // KILL QUERY). No-op if the backend PID was never captured.
  cancel(conn: LiveConnection, handle: QueryHandle): Promise<void>
  // Releases the pool.
  close(conn: LiveConnection): Promise<void>
}

// Shared cap logic: query with `cap + 1`, then a level is truncated when the
// server returned more than the cap allowed. Returns the kept slice + the flag.
export function applyCap<T>(rows: T[], cap: number): { kept: T[]; truncated: boolean } {
  if (rows.length > cap) {
    return { kept: rows.slice(0, cap), truncated: true }
  }
  return { kept: rows, truncated: false }
}

// Why: a localhost server usually has no cert to verify, while any remote host
// should verify by default. An explicit user-chosen mode always wins.
export function isLocalHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '')
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0.0.0.0'
}

export function resolveSslMode(ssl: DbSslMode | undefined, host: string): ResolvedSslMode {
  if (ssl) {
    return ssl
  }
  return isLocalHost(host) ? 'disable' : 'verify-full'
}

// Collapse a persisted connection + its decrypted password into a dial-ready
// config. Smart-by-host SSL is resolved here so drivers see a concrete mode.
export function resolveDbConfig(
  connection: DbConnection,
  decryptedPassword: string | undefined
): ResolvedDbConfig {
  return {
    id: connection.id,
    engine: connection.engine,
    host: connection.host,
    port: connection.port,
    database: connection.database,
    user: connection.user,
    password: decryptedPassword,
    ssl: resolveSslMode(connection.ssl, connection.host),
    readOnly: connection.readOnly
  }
}

export class DbTimeoutError extends Error {
  constructor() {
    super('db_connect_timeout')
    this.name = 'DbTimeoutError'
  }
}

// Belt-and-suspenders around the driver-native connect timeout: guarantees the
// IPC settles even if a driver ignores its own timeout option. `onTimeout` lets
// the caller tear down the half-open socket the losing promise still owns.
export function raceWithTimeout<T>(
  promise: Promise<T>,
  ms: number,
  onTimeout?: () => void
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout?.()
      reject(new DbTimeoutError())
    }, ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      }
    )
  })
}

// ── Error normalization (red-team F6) ────────────────────────────────
//
// Raw driver errors embed the DSN, host, user, and sometimes the password;
// there is no IPC redactor. Map known driver error codes to a fixed, credential-
// free { code, safeMessage } and fall back to a generic message otherwise — the
// raw message is NEVER forwarded.

const SAFE_MESSAGES: Record<string, string> = {
  auth_failed: 'Authentication failed. Check the user name and password.',
  database_not_found: 'The specified database does not exist.',
  host_unreachable: 'Could not resolve or reach the database host.',
  connection_refused: 'Connection refused by the host.',
  timeout: 'Connection timed out.',
  tls_error: 'TLS/SSL negotiation failed.',
  decrypt_failed: 'The stored password could not be decrypted on this machine.',
  not_connected: 'The connection is not open.',
  read_only_blocked: 'Read-only connection: run one statement at a time.',
  busy: 'A query is already running on this connection.',
  unknown: 'Could not connect to the database.'
}

// Internal error strings raised by our own code (credential store, manager);
// surface them as clear codes rather than a bare "unknown".
const MESSAGE_CODE_MAP: Record<string, keyof typeof SAFE_MESSAGES> = {
  db_secret_unknown_format: 'decrypt_failed',
  db_secret_encrypt_failed: 'decrypt_failed',
  db_not_connected: 'not_connected',
  db_read_only_multi_statement: 'read_only_blocked',
  db_query_in_progress: 'busy'
}

// Driver error code → safe code. Covers pg (SQLSTATE + libpq errno) and mysql2
// (ER_*/PROTOCOL_*) plus shared Node socket/TLS errnos.
const DRIVER_CODE_MAP: Record<string, keyof typeof SAFE_MESSAGES> = {
  // Postgres SQLSTATE
  '28P01': 'auth_failed',
  '28000': 'auth_failed',
  '3D000': 'database_not_found',
  // MySQL ER_*
  ER_ACCESS_DENIED_ERROR: 'auth_failed',
  ER_DBACCESS_DENIED_ERROR: 'auth_failed',
  ER_BAD_DB_ERROR: 'database_not_found',
  PROTOCOL_SEQUENCE_TIMEOUT: 'timeout',
  PROTOCOL_CONNECTION_LOST: 'connection_refused',
  HANDSHAKE_SSL_ERROR: 'tls_error',
  // Shared Node socket/DNS/TLS errnos
  ECONNREFUSED: 'connection_refused',
  ECONNRESET: 'connection_refused',
  ENOTFOUND: 'host_unreachable',
  EAI_AGAIN: 'host_unreachable',
  EHOSTUNREACH: 'host_unreachable',
  ENETUNREACH: 'host_unreachable',
  ETIMEDOUT: 'timeout',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'tls_error',
  SELF_SIGNED_CERT_IN_CHAIN: 'tls_error',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'tls_error',
  ERR_TLS_CERT_ALTNAME_INVALID: 'tls_error',
  CERT_HAS_EXPIRED: 'tls_error'
}

export function normalizeDbError(err: unknown): DbSafeError {
  if (err instanceof DbTimeoutError) {
    return { code: 'timeout', safeMessage: SAFE_MESSAGES.timeout }
  }
  const rawCode =
    typeof err === 'object' && err !== null && 'code' in err
      ? String((err as { code: unknown }).code)
      : undefined
  const rawMessage = err instanceof Error ? err.message : undefined
  const safeCode =
    (rawCode && DRIVER_CODE_MAP[rawCode]) ||
    (rawMessage && MESSAGE_CODE_MAP[rawMessage]) ||
    'unknown'
  return { code: safeCode, safeMessage: SAFE_MESSAGES[safeCode] }
}

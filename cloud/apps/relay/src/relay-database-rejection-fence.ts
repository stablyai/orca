import pg from 'pg'
import {
  isPostgresPoolAcquireFailure,
  isPostgresPoolConnectFailure
} from './postgres-pool-pressure.js'

// A database fault reaching unhandledRejection must not kill the cell: on 09-28 one failover
// crashed 18 cells and dropped ~16k hosts. A rejection is fenced only when both hold:
//   path: the relay's database layer threw or rethrew it (marked below), and
//   type: a pool acquire failure, pg's read timeout, a dropped connection, or a server error
//         in class 08/40/53/55/57/58 (the database is unwell) or 23 (a constraint lost a race
//         with a concurrent writer; the row it guards is intact, so the process is too).
// Everything else stays fatal: schema errors (42), data errors (22), TypeErrors from pg's
// parameter serialisation, and every bare socket errno from ws or fetch.
const databaseLayerErrors = new WeakSet<object>()

// Set by pg's query_timeout timer (pg@8.22 client.js).
export const POSTGRES_READ_TIMEOUT_MESSAGE = 'Query read timeout'
const CONNECTION_TERMINATED_PREFIX = 'Connection terminated'
// pg@8.22 rejects the active query with the raw socket error when the connection drops.
const DROPPED_SOCKET_ERRNOS = new Set(['ECONNRESET', 'EPIPE'])
const FENCED_SQLSTATE_CLASSES = new Set(['08', '23', '40', '53', '55', '57', '58'])
// Class 25 is otherwise a code error (a statement in the wrong transaction state). 25P03 is the
// server ending a session left idle in a transaction past 5 s, which a whole-VM stall of 6-7 s
// does to any backend caught idle mid-transaction at its onset.
const FENCED_SQLSTATES = new Set(['25P03'])

export function isPostgresReadTimeout(error: unknown): error is Error {
  return error instanceof Error && error.message === POSTGRES_READ_TIMEOUT_MESSAGE
}

// The database layer threw or rethrew this; an errno or message alone could be any socket's.
export function isRelayDatabaseLayerError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  return databaseLayerErrors.has(error) || isPostgresPoolAcquireFailure(error)
}

export function markRelayDatabaseError(error: unknown): void {
  if (typeof error === 'object' && error !== null) databaseLayerErrors.add(error)
}

export function isFencedRelayDatabaseRejection(reason: unknown): boolean {
  if (typeof reason !== 'object' || reason === null) return false
  // Any acquire failure, including a 28P01 at connect: no statement ran, so nothing is unknown.
  if (isPostgresPoolAcquireFailure(reason)) return true
  if (!databaseLayerErrors.has(reason)) return false
  if (isPostgresPoolConnectFailure(reason)) return true
  if (reason instanceof pg.DatabaseError) {
    const code = String(reason.code)
    return FENCED_SQLSTATE_CLASSES.has(code.slice(0, 2)) || FENCED_SQLSTATES.has(code)
  }
  if (!(reason instanceof Error) || reason instanceof TypeError) return false
  return (
    ('code' in reason && DROPPED_SOCKET_ERRNOS.has(String(reason.code))) ||
    reason.message === POSTGRES_READ_TIMEOUT_MESSAGE ||
    reason.message.startsWith(CONNECTION_TERMINATED_PREFIX)
  )
}

function rejectionFields(reason: unknown): { code: string; message: string } {
  const error = typeof reason === 'object' && reason !== null ? reason : {}
  const code = 'code' in error ? String(error.code) : ''
  const message = 'message' in error ? String(error.message) : String(reason)
  // Server messages can quote values; the code and the start of the message identify the fault.
  return { code, message: message.replace(/[^\x20-\x7e]/g, '').slice(0, 120) }
}

// Installed once by the process entry point. Fatal rejections are rethrown, which ends the
// process exactly as Node's default would, after one line that names them.
export function handleRelayUnhandledRejection(reason: unknown): void {
  if (isFencedRelayDatabaseRejection(reason)) {
    console.warn(
      JSON.stringify({ event: 'orca_relay_database_rejection_fenced', ...rejectionFields(reason) })
    )
    return
  }
  console.error(
    JSON.stringify({
      event: 'orca_relay_process_fatal',
      kind: 'unhandled-rejection',
      ...rejectionFields(reason)
    })
  )
  throw reason
}

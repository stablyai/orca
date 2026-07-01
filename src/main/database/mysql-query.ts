// MySQL query execution + cancellation, split out of the driver so the streaming
// / transaction / cancel logic stays focused and testable.
//
// Read-only enforcement (red-team F3): reads run inside `START TRANSACTION READ
// ONLY`, so the database rejects writes — not a keyword check. Multi-statement is
// already off (multipleStatements:false).
// Result bounding (red-team F9): SELECTs stream row-by-row and stop after
// rowLimit+1, so a huge result never buffers whole; the user's SQL is never
// rewritten (no appended LIMIT).
// Cancellation (red-team F10): the connection id is captured at start and killed
// from a separate short-lived connection via KILL QUERY.

import type { Readable } from 'node:stream'
import { isCursorableRead } from '../../shared/sql-statement-classifier'
import { DbBatchError } from './db-driver'
import type {
  DbStatement,
  QueryHandle,
  QueryOptions,
  QueryResult
} from '../../shared/database-types'
import type { Connection, Pool, PoolConnection } from 'mysql2/promise'

type BoundedRows = { columns: { name: string }[]; rows: unknown[][]; rowCount: number; truncated: boolean }

// Minimal shape of the core (callback) connection reachable via `.connection`,
// used only for row-by-row streaming (the promise API buffers whole results).
type StreamingCore = {
  query(opts: { sql: string; rowsAsArray: boolean }): {
    on(event: 'fields', cb: (fields: { name: string }[]) => void): unknown
    on(event: 'error', cb: (err: unknown) => void): unknown
    stream(): Readable
  }
}

function normalizeFields(fields: { name: string }[] | undefined): { name: string }[] {
  return (fields ?? []).map((f) => ({ name: f.name }))
}

// Stream a SELECT, keeping at most rowLimit rows; the (rowLimit+1)-th row only
// flips `truncated` and triggers an early stream teardown.
function streamBounded(
  core: StreamingCore,
  sql: string,
  rowLimit: number,
  onEarlyStop: () => void
): Promise<BoundedRows> {
  return new Promise<BoundedRows>((resolve, reject) => {
    let columns: { name: string }[] = []
    const rows: unknown[][] = []
    let settled = false
    const settle = (fn: (value: never) => void, value: unknown): void => {
      if (!settled) {
        settled = true
        ;(fn as (v: unknown) => void)(value)
      }
    }
    const q = core.query({ sql, rowsAsArray: true })
    q.on('fields', (fields) => {
      columns = normalizeFields(fields)
    })
    q.on('error', (err) => settle(reject, err))
    const stream = q.stream()
    stream.on('data', (row: unknown[]) => {
      if (rows.length >= rowLimit) {
        onEarlyStop()
        stream.destroy()
        settle(resolve, { columns, rows, rowCount: rows.length, truncated: true })
        return
      }
      rows.push(row)
    })
    stream.on('error', (err) => settle(reject, err))
    stream.on('end', () => settle(resolve, { columns, rows, rowCount: rows.length, truncated: false }))
  })
}

// Non-cursorable statements (writes/DDL) run directly; they return a header, not
// rows. rowsAsArray keeps any returned rows positional. A client-side `timeout`
// bounds writes (red-team L1) — `max_execution_time` only covers SELECT.
async function runDirect(conn: PoolConnection, sql: string, timeoutMs: number): Promise<BoundedRows> {
  const [result, fields] = await conn.query({ sql, rowsAsArray: true, timeout: timeoutMs })
  if (Array.isArray(result)) {
    const rows = result as unknown[][]
    return { columns: normalizeFields(fields as { name: string }[]), rows, rowCount: rows.length, truncated: false }
  }
  const affected = (result as { affectedRows?: number }).affectedRows ?? 0
  return { columns: [], rows: [], rowCount: affected, truncated: false }
}

export async function runMysqlQuery(
  pool: Pool,
  connectionId: string,
  sql: string,
  opts: QueryOptions,
  onStart: (handle: QueryHandle) => void
): Promise<QueryResult> {
  const conn = await pool.getConnection()
  let poisoned = false
  try {
    const [pidRows] = await conn.query('SELECT CONNECTION_ID() AS id')
    const backendPid = Number((pidRows as { id?: number }[])[0]?.id) || null
    onStart({ connectionId, backendPid })

    // max_execution_time bounds SELECTs (ms); the read-only transaction is the
    // write boundary when !allowWrite.
    await conn.query(`SET SESSION max_execution_time = ${Math.trunc(opts.timeoutMs)}`)
    await conn.query(opts.allowWrite ? 'START TRANSACTION' : 'START TRANSACTION READ ONLY')
    const startedAt = Date.now()
    try {
      const bounded = isCursorableRead(sql)
        ? await streamBounded(
            (conn as unknown as { connection: StreamingCore }).connection,
            sql,
            opts.rowLimit,
            () => {
              poisoned = true
            }
          )
        : await runDirect(conn, sql, opts.timeoutMs)
      // H2 (red-team): a stream torn down early leaves undrained packets on the
      // socket — COMMIT here would either desync (losing the valid truncated
      // rows behind a spurious error) or drain the full result (defeating the
      // bound). Skip it: the read-only transaction is abandoned when `finally`
      // destroys the poisoned connection.
      if (!poisoned) {
        await conn.query('COMMIT')
      }
      return { ...bounded, durationMs: Date.now() - startedAt }
    } catch (err) {
      await conn.query('ROLLBACK').catch(() => {})
      throw err
    }
  } finally {
    // A stream torn down mid-result leaves unread packets on the socket; drop the
    // connection instead of returning a poisoned one to the pool.
    if (poisoned) {
      conn.destroy()
    } else {
      conn.release()
    }
  }
}

// Runs one parameterized statement (Data-tab select/count/mutation or wrapped
// free-form re-query) inside a transaction — read-only when !allowWrite. The
// statement's own LIMIT bounds the page; rowLimit is a defensive server-side cap.
export async function runMysqlExecute(
  pool: Pool,
  connectionId: string,
  statement: DbStatement,
  opts: QueryOptions,
  onStart: (handle: QueryHandle) => void
): Promise<QueryResult> {
  const conn = await pool.getConnection()
  try {
    const [pidRows] = await conn.query('SELECT CONNECTION_ID() AS id')
    onStart({ connectionId, backendPid: Number((pidRows as { id?: number }[])[0]?.id) || null })
    await conn.query(`SET SESSION max_execution_time = ${Math.trunc(opts.timeoutMs)}`)
    await conn.query(opts.allowWrite ? 'START TRANSACTION' : 'START TRANSACTION READ ONLY')
    const startedAt = Date.now()
    try {
      const [result, fields] = await conn.query({
        sql: statement.sql,
        values: statement.params,
        rowsAsArray: true,
        timeout: opts.timeoutMs
      })
      await conn.query('COMMIT')
      if (Array.isArray(result)) {
        const allRows = result as unknown[][]
        const truncated = allRows.length > opts.rowLimit
        const rows = truncated ? allRows.slice(0, opts.rowLimit) : allRows
        return {
          columns: normalizeFields(fields as { name: string }[]),
          rows,
          rowCount: rows.length,
          truncated,
          durationMs: Date.now() - startedAt
        }
      }
      const affected = (result as { affectedRows?: number }).affectedRows ?? 0
      return { columns: [], rows: [], rowCount: affected, truncated: false, durationMs: Date.now() - startedAt }
    } catch (err) {
      await conn.query('ROLLBACK').catch(() => {})
      throw err
    }
  } finally {
    conn.release()
  }
}

// Applies staged writes atomically: START TRANSACTION, run each statement in
// order, COMMIT. Any failure rolls back and throws DbBatchError(failedIndex).
export async function runMysqlBatch(
  pool: Pool,
  connectionId: string,
  statements: DbStatement[],
  opts: QueryOptions,
  onStart: (handle: QueryHandle) => void
): Promise<number[]> {
  const conn = await pool.getConnection()
  try {
    const [pidRows] = await conn.query('SELECT CONNECTION_ID() AS id')
    onStart({ connectionId, backendPid: Number((pidRows as { id?: number }[])[0]?.id) || null })
    await conn.query(`SET SESSION max_execution_time = ${Math.trunc(opts.timeoutMs)}`)
    await conn.query('START TRANSACTION')
    const rowCounts: number[] = []
    for (let i = 0; i < statements.length; i++) {
      try {
        const [result] = await conn.query({
          sql: statements[i].sql,
          values: statements[i].params,
          timeout: opts.timeoutMs
        })
        rowCounts.push((result as { affectedRows?: number }).affectedRows ?? 0)
      } catch (err) {
        await conn.query('ROLLBACK').catch(() => {})
        throw new DbBatchError(i, err)
      }
    }
    await conn.query('COMMIT')
    return rowCounts
  } finally {
    conn.release()
  }
}

export async function cancelMysqlQuery(conn: Connection, threadId: number): Promise<void> {
  try {
    // KILL QUERY takes no placeholder; threadId is a captured integer.
    await conn.query(`KILL QUERY ${Math.trunc(threadId)}`)
  } finally {
    await conn.end().catch(() => {})
  }
}

// Postgres query execution + cancellation, kept out of the driver file so the
// transaction / cursor / cancel logic stays focused and testable.
//
// Read-only enforcement (red-team F3): reads run inside `BEGIN` +
// `SET TRANSACTION READ ONLY`, so the database — not a keyword check — rejects
// writes, multi-statement writes, and writing CTEs.
// Result bounding (red-team F9): a SELECT runs through a server-side cursor,
// fetching only rowLimit+1 rows; the user's SQL is never rewritten (no appended
// LIMIT), so trailing semicolons / existing LIMIT / multi-statement stay intact.
// Cancellation (red-team F10): the backend PID is captured at start and cancelled
// from a separate short-lived connection.

import { isCursorableRead } from '../../shared/sql-statement-classifier'
import type { QueryHandle, QueryOptions, QueryResult } from '../../shared/database-types'
import type { Client, Pool, PoolClient } from 'pg'

const CURSOR_NAME = 'orca_query_cursor'

type BoundedRows = { columns: { name: string }[]; rows: unknown[][]; rowCount: number; truncated: boolean }

async function fetchBounded(client: PoolClient, sql: string, rowLimit: number): Promise<BoundedRows> {
  if (isCursorableRead(sql)) {
    // DECLARE the user's query as a cursor, then FETCH one more than the cap to
    // detect overflow. The SQL is embedded verbatim (a cursor query can't be
    // parameterized) — safe here since it is the user's own SQL on their own DB.
    await client.query(`DECLARE ${CURSOR_NAME} NO SCROLL CURSOR FOR ${sql}`)
    const fetched = await client.query({
      text: `FETCH FORWARD ${rowLimit + 1} FROM ${CURSOR_NAME}`,
      rowMode: 'array'
    })
    await client.query(`CLOSE ${CURSOR_NAME}`)
    const truncated = fetched.rows.length > rowLimit
    const rows = truncated ? fetched.rows.slice(0, rowLimit) : fetched.rows
    return {
      columns: (fetched.fields ?? []).map((f) => ({ name: f.name })),
      rows,
      rowCount: rows.length,
      truncated
    }
  }
  // Writes / non-cursorable statements: run directly (they return few/no rows).
  const result = await client.query({ text: sql, rowMode: 'array' })
  const rows = (result.rows ?? []) as unknown[][]
  return {
    columns: (result.fields ?? []).map((f) => ({ name: f.name })),
    rows,
    rowCount: result.rowCount ?? rows.length,
    truncated: false
  }
}

export async function runPostgresQuery(
  pool: Pool,
  connectionId: string,
  sql: string,
  opts: QueryOptions,
  onStart: (handle: QueryHandle) => void
): Promise<QueryResult> {
  const client = await pool.connect()
  try {
    const pidResult = await client.query('SELECT pg_backend_pid() AS pid')
    const backendPid = Number(pidResult.rows[0]?.pid) || null
    onStart({ connectionId, backendPid })

    await client.query(`SET statement_timeout = ${Math.trunc(opts.timeoutMs)}`)
    await client.query('BEGIN')
    if (!opts.allowWrite) {
      await client.query('SET TRANSACTION READ ONLY')
    }
    const startedAt = Date.now()
    try {
      const bounded = await fetchBounded(client, sql, opts.rowLimit)
      await client.query('COMMIT')
      return { ...bounded, durationMs: Date.now() - startedAt }
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    }
  } finally {
    client.release()
  }
}

export async function cancelPostgresBackend(client: Client, backendPid: number): Promise<void> {
  await client.connect()
  try {
    await client.query('SELECT pg_cancel_backend($1)', [backendPid])
  } finally {
    await client.end().catch(() => {})
  }
}

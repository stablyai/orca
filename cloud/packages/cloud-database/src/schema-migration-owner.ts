import { createHash } from 'node:crypto'
import { applyPostgresSchema, sqlWithoutComments } from '@orca-cloud/postgres-schema'
import type { CloudDatabase } from './cloud-database.js'

// How long a booting instance waits for another's schema step before its boot fails and retries.
const MIGRATION_LOCK_WAIT_MS = 60_000
const DATA_STATEMENT = /^(?:INSERT|UPDATE|DELETE)\b/i
// Data statements a database has run, so later boots never repeat them.
const DATA_CHANGES_LEDGER = `CREATE TABLE IF NOT EXISTS orca_schema_data_changes (
  statement_sha256 TEXT PRIMARY KEY,
  applied_at BIGINT NOT NULL
)`

// A backfill or copy, run by the first boot to reach it and recorded in the same transaction.
async function runDataStatementOnce(
  transaction: CloudDatabase,
  service: string,
  statement: string
): Promise<void> {
  const hash = createHash('sha256').update(statement).digest('hex')
  const [done] = await transaction.query(
    'SELECT 1 AS done FROM orca_schema_data_changes WHERE statement_sha256 = ?',
    [hash]
  )
  if (done) {
    return
  }
  const [result] = await transaction.query(statement)
  await transaction.query(
    'INSERT INTO orca_schema_data_changes (statement_sha256, applied_at) VALUES (?, ?)',
    [hash, Date.now()]
  )
  console.log(
    JSON.stringify({
      event: `orca_${service}_postgres_schema_data_change_applied`,
      statement: sqlWithoutComments(statement).split('\n')[0],
      rows: Number(result?.changes ?? 0)
    })
  )
}

// Boot DDL and data for a service whose instances overlap. One boot at a time holds the service's
// migration lock for the whole list, so overlapping boots never race the same DDL; the ones after
// skip already-applied DDL from the catalog, taking no table lock, and run no data statement twice.
export async function applyOwnedPostgresSchema(input: {
  // Statements on the one connection that holds the session lock.
  session: CloudDatabase
  transaction: <T>(operation: (transaction: CloudDatabase) => Promise<T>) => Promise<T>
  service: string
  schemaStatements: string[]
  lockTimeoutMs: number
  beforeSchema?: (transaction: CloudDatabase) => Promise<void>
}): Promise<void> {
  const { session, transaction, service, schemaStatements, lockTimeoutMs, beforeSchema } = input
  const lockKey = `orca-${service}-schema-migration`
  await session.query(`SET lock_timeout = ${MIGRATION_LOCK_WAIT_MS}`)
  await session.query('SELECT pg_advisory_lock(hashtext(?::text))', [lockKey])
  try {
    await session.query(`SET lock_timeout = ${lockTimeoutMs}`)
    await session.query(DATA_CHANGES_LEDGER)
    if (beforeSchema) {
      await transaction(beforeSchema)
    }
    await applyPostgresSchema(
      schemaStatements,
      (statement) =>
        DATA_STATEMENT.test(sqlWithoutComments(statement))
          ? transaction((tx) => runDataStatementOnce(tx, service, statement))
          : session.query(statement),
      {
        eventPrefix: `orca_${service}_postgres_schema`,
        catalogQuery: async (sql, params) => await session.query(sql, params)
      }
    )
  } finally {
    // A failed connection ends its session, which releases the lock as well.
    await session.query('SELECT pg_advisory_unlock(hashtext(?::text))', [lockKey]).catch(() => {})
  }
}

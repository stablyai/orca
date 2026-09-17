import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  applyPostgresSchema,
  catalogObjectPresence,
  schemaLockTarget,
  takesRelationLock
} from '@orca-cloud/postgres-schema'
import {
  openRelayDatabase,
  POSTGRES_LOCK_TIMEOUT_MS,
  relayPostgresSchemaStatements,
  type RelayDatabase
} from './database.js'

// The outage this guards against: CREATE INDEX IF NOT EXISTS takes its relation lock before the
// server evaluates the existence test, so on a database that already has the index the boot still
// joins the lock queue, and relation locks are granted in queue order, so every writer queues
// behind it. Only a real server can show that the catalog pre-check removes those statements.
const databaseUrl = process.env.ORCA_RELAY_TEST_POSTGRES_URL
const describePostgres = databaseUrl ? describe : describe.skip
const schema = 'relay_schema_precheck_test'

// A table the boot would otherwise touch with two CREATE INDEX statements, and the largest table
// in production.
const LOCKED_TABLE = 'relay_control_connection_reservations'

function scopedUrl(): string {
  const url = new URL(databaseUrl!)
  url.searchParams.set('options', `-c search_path=${schema}`)
  return url.toString()
}

async function onAdmin<T>(operation: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: databaseUrl })
  await client.connect()
  try {
    return await operation(client)
  } finally {
    await client.end()
  }
}

describePostgres('relay boot-time schema against PostgreSQL', () => {
  let url = ''
  let pool: pg.Pool
  let sent: string[]
  const opened: RelayDatabase[] = []

  beforeAll(() => {
    url = scopedUrl()
  })

  beforeEach(async () => {
    await onAdmin(async (client) => {
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
      await client.query(`CREATE SCHEMA ${schema}`)
    })
    // Same lock bound the boot pool uses, so a statement that still queues fails instead of
    // hanging the test.
    pool = new pg.Pool({ connectionString: url, max: 1, lock_timeout: POSTGRES_LOCK_TIMEOUT_MS })
    sent = []
  })

  afterAll(async () => {
    await Promise.all(opened.map((database) => database.close().catch(() => undefined)))
    await onAdmin((client) => client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`))
  })

  async function applyRecording(): Promise<{ ran: number; skipped: number }> {
    const record = async (statement: string, params: unknown[] = []): Promise<pg.QueryResult> => {
      sent.push(statement)
      return await pool.query(statement, params)
    }
    return await applyPostgresSchema(
      relayPostgresSchemaStatements(),
      (statement) => record(statement),
      { catalogQuery: async (sql, params) => (await record(sql, params)).rows }
    )
  }

  function lockTaking(): string[] {
    return sent.filter(takesRelationLock)
  }

  it('creates the schema cold, then issues no lock-taking statement on the next boot', async () => {
    const cold = await applyRecording()
    expect(lockTaking().length).toBeGreaterThan(0)
    expect(cold.skipped).toBeGreaterThan(0)

    sent = []
    const warm = await applyRecording()
    // Zero, with no exceptions: every statement that takes a relation lock has a pre-check.
    expect(lockTaking()).toEqual([])
    const preCheckedCount = relayPostgresSchemaStatements().filter(
      (statement) => schemaLockTarget(statement) !== undefined
    ).length
    expect(warm.skipped).toBe(preCheckedCount)
    expect(warm.ran).toBe(relayPostgresSchemaStatements().length - preCheckedCount)
    // The CREATE TABLEs still run: they resolve a name and take no lock on an existing table.
    expect(warm.ran).toBeGreaterThan(0)
    await pool.end()
  })

  it('skips an index a failed concurrent build left invalid instead of rebuilding it', async () => {
    await applyRecording()
    // A cancelled CREATE INDEX CONCURRENTLY leaves exactly this state, and IF NOT EXISTS skips it
    // too, so reading indisvalid as a condition would newly take the lock it used to avoid.
    await pool.query(
      `UPDATE pg_catalog.pg_index SET indisvalid = false
       WHERE indexrelid = to_regclass('${schema}.relay_audit_events_at')`
    )
    sent = []
    await applyRecording()
    expect(lockTaking()).toEqual([])
    await pool.end()
  })

  it('re-adds a constraint an operator dropped, then skips it again', async () => {
    // The pre-check matches the constraint by name only, so this is the one shape where a changed
    // body needs an operator: drop it, and the next boot puts the current definition back.
    await applyRecording()
    const named = async (): Promise<number> =>
      Number(
        (
          await pool.query(
            `SELECT count(*) AS present FROM pg_catalog.pg_constraint
             WHERE conrelid = to_regclass('relay_region_rehome_attempts')
               AND conname = 'relay_region_rehome_attempts_preferred_region_valid'`
          )
        ).rows[0]?.present
      )
    expect(await named()).toBe(1)

    await pool.query(
      `ALTER TABLE relay_region_rehome_attempts
       DROP CONSTRAINT relay_region_rehome_attempts_preferred_region_valid`
    )
    sent = []
    await applyRecording()
    expect(lockTaking()).toHaveLength(1)
    expect(await named()).toBe(1)

    sent = []
    await applyRecording()
    expect(lockTaking()).toEqual([])
    await pool.end()
  })

  it('does not let a same-named index on a sibling table answer for this one', async () => {
    // Index names are unique per schema, not per table, so a name freed on one table and taken on
    // another is reachable. Without tying the index to the table, the pre-check reads that sibling
    // as this table's index and skips the real CREATE INDEX for good.
    await applyRecording()
    const ask = async (table: string): Promise<boolean> =>
      (
        await catalogObjectPresence(
          async (sql, params) => (await pool.query(sql, params)).rows,
          { kind: 'index', table, name: 'relay_audit_events_at', skipWhen: 'present' }
        )
      ).present

    expect(await ask('relay_audit_events')).toBe(true)
    await pool.query(`DROP INDEX ${schema}.relay_audit_events_at`)
    await pool.query(`CREATE TABLE ${schema}.precheck_sibling (at BIGINT)`)
    await pool.query(`CREATE INDEX relay_audit_events_at ON ${schema}.precheck_sibling(at)`)

    expect(await ask('relay_audit_events')).toBe(false)
    expect(await ask('precheck_sibling')).toBe(true)
    await pool.end()
  })

  it('boots while another session holds ACCESS EXCLUSIVE on the largest table', async () => {
    // The end-to-end proof through openRelayDatabase: with the lock held, any DDL the boot still
    // sent against this table would hit lock_timeout, and 55P03 is no longer retried.
    const cold = await openRelayDatabase({ databaseUrl: url, dataDir: '' })
    opened.push(cold)
    await pool.end()

    const holder = new pg.Client({ connectionString: url })
    await holder.connect()
    await holder.query('BEGIN')
    await holder.query(`LOCK TABLE ${LOCKED_TABLE} IN ACCESS EXCLUSIVE MODE`)
    try {
      const warm = await openRelayDatabase({ databaseUrl: url, dataDir: '' })
      opened.push(warm)
    } finally {
      await holder.query('ROLLBACK')
      await holder.end()
    }
  })

  it('fails that same boot with 55P03 when the pre-check is not wired in', async () => {
    // Keeps the test above from passing vacuously: the lock really does block relay's DDL.
    const cold = await openRelayDatabase({ databaseUrl: url, dataDir: '' })
    opened.push(cold)

    const holder = new pg.Client({ connectionString: url })
    await holder.connect()
    await holder.query('BEGIN')
    await holder.query(`LOCK TABLE ${LOCKED_TABLE} IN ACCESS EXCLUSIVE MODE`)
    try {
      await expect(
        applyPostgresSchema(
          relayPostgresSchemaStatements(),
          (statement) => pool.query(statement),
          { retryDeadlineMs: 0 }
        )
      ).rejects.toMatchObject({ code: '55P03' })
    } finally {
      await holder.query('ROLLBACK')
      await holder.end()
      await pool.end()
    }
  })
})

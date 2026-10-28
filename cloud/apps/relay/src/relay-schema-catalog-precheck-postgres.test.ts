import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
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

// IF NOT EXISTS acquires relation locks before checking existence, queueing writers behind boot DDL; prove catalog prechecks avoid it on a real server.
const databaseUrl = process.env.ORCA_RELAY_TEST_POSTGRES_URL
const describePostgres = databaseUrl ? describe : describe.skip
const schema = 'relay_schema_precheck_test'

// Largest production table, otherwise touched by two boot CREATE INDEX statements.
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
    // Match boot’s lock timeout so any DDL still queued fails promptly.
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
    // Cancelled concurrent indexes can be invalid; IF NOT EXISTS still skips them, so indisvalid must not newly trigger DDL.
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
    // Name-only constraint checks require operators to drop changed definitions before boot recreates them.
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
    // Index names are schema-wide; bind name to table or a sibling’s index can permanently suppress the real CREATE.
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
    // Exercise openRelayDatabase: leftover DDL against the held lock would fail with unretried 55P03.
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

  it('throttles the reservations vacuum, deferring it while a vacuum holds the table', async () => {
    const reservationOptions = async (): Promise<unknown> =>
      (
        await pool.query(`SELECT reloptions FROM pg_class WHERE oid = to_regclass($1)`, [
          `${schema}.${LOCKED_TABLE}`
        ])
      ).rows[0]?.reloptions
    const cold = await openRelayDatabase({ databaseUrl: url, dataDir: '' })
    opened.push(cold)
    expect(await reservationOptions()).toEqual([
      'autovacuum_vacuum_cost_delay=20',
      'autovacuum_vacuum_cost_limit=200'
    ])
    await pool.query(
      `ALTER TABLE ${schema}.${LOCKED_TABLE}
         RESET (autovacuum_vacuum_cost_delay, autovacuum_vacuum_cost_limit)`
    )

    // The lock a running (auto)vacuum holds; the boot must yield to it rather than fail.
    const holder = new pg.Client({ connectionString: url })
    await holder.connect()
    await holder.query('BEGIN')
    await holder.query(`LOCK TABLE ${LOCKED_TABLE} IN SHARE UPDATE EXCLUSIVE MODE`)
    try {
      const behindVacuum = await openRelayDatabase({ databaseUrl: url, dataDir: '' })
      opened.push(behindVacuum)
    } finally {
      await holder.query('ROLLBACK')
      await holder.end()
    }
    expect(await reservationOptions()).toBeNull()

    const next = await openRelayDatabase({ databaseUrl: url, dataDir: '' })
    opened.push(next)
    expect(await reservationOptions()).toEqual([
      'autovacuum_vacuum_cost_delay=20',
      'autovacuum_vacuum_cost_limit=200'
    ])
    await pool.end()
  })

  it('defers the activity-lease migrations and still boots while their table is locked', async () => {
    // Migration DROP must defer behind writers or 28 directors crash-loop on a table written ~475/s.
    const cold = await openRelayDatabase({ databaseUrl: url, dataDir: '' })
    opened.push(cold)
    // Put the database back in its pre-migration shape, which is what makes the drop lock-taking.
    await pool.query(
      `CREATE INDEX relay_assignment_activity_expiry
         ON ${schema}.relay_assignment_activity_leases(expires_at)`
    )
    await pool.query(`ALTER TABLE ${schema}.relay_assignment_activity_leases RESET (fillfactor)`)

    const warned: string[] = []
    const warn = vi.spyOn(console, 'warn').mockImplementation((line: string) => {
      warned.push(line)
    })
    const holder = new pg.Client({ connectionString: url })
    await holder.connect()
    await holder.query('BEGIN')
    await holder.query(
      `LOCK TABLE ${schema}.relay_assignment_activity_leases IN ACCESS EXCLUSIVE MODE`
    )
    let summary: Awaited<ReturnType<typeof applyPostgresSchema>>
    try {
      summary = await applyPostgresSchema(
        relayPostgresSchemaStatements(),
        (statement) => pool.query(statement),
        { catalogQuery: async (sql, params) => (await pool.query(sql, params)).rows }
      )
    } finally {
      await holder.query('ROLLBACK')
      await holder.end()
      warn.mockRestore()
    }

    expect(summary.deferred).toBe(2)
    expect(summary.ran).toBeGreaterThan(0)
    const deferred = warned
      .map((line) => JSON.parse(line) as { event?: string; name?: string })
      .filter((event) => event.event === 'orca_relay_postgres_schema_object_deferred')
    expect(deferred.map((event) => event.name)).toEqual([
      'relay_assignment_activity_expiry',
      'fillfactor=70'
    ])
    const stillThere = await pool.query(
      `SELECT 1 FROM pg_indexes WHERE schemaname = $1 AND indexname = $2`,
      [schema, 'relay_assignment_activity_expiry']
    )
    expect(stillThere.rowCount).toBe(1)

    const retry = await applyPostgresSchema(
      relayPostgresSchemaStatements(),
      (statement) => pool.query(statement),
      { catalogQuery: async (sql, params) => (await pool.query(sql, params)).rows }
    )
    expect(retry.deferred).toBe(0)
    const gone = await pool.query(
      `SELECT 1 FROM pg_indexes WHERE schemaname = $1 AND indexname = $2`,
      [schema, 'relay_assignment_activity_expiry']
    )
    expect(gone.rowCount).toBe(0)
    const options = await pool.query(
      `SELECT reloptions FROM pg_class WHERE oid = to_regclass($1)`,
      [`${schema}.relay_assignment_activity_leases`]
    )
    expect(options.rows[0]?.reloptions).toEqual(['fillfactor=70'])
    await pool.end()
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

import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { applyPostgresSchema } from '@orca-cloud/postgres-schema/apply-postgres-schema'
import { catalogObjectPresence } from '@orca-cloud/postgres-schema/catalog-object-precheck'
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
  })

  afterAll(async () => {
    await Promise.all(opened.map((database) => database.close().catch(() => undefined)))
    await onAdmin((client) => client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`))
  })

  async function applySchema(): Promise<void> {
    await applyPostgresSchema(
      relayPostgresSchemaStatements(),
      (statement) => pool.query(statement),
      { catalogQuery: async (sql, params) => (await pool.query(sql, params)).rows }
    )
  }

  it('re-adds a constraint an operator dropped', async () => {
    // Name-only constraint checks require operators to drop changed definitions before boot recreates them.
    await applySchema()
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
    await applySchema()
    expect(await named()).toBe(1)
    await pool.end()
  })

  it('does not let a same-named index on a sibling table answer for this one', async () => {
    // Index names are schema-wide; bind name to table or a sibling’s index can permanently suppress the real CREATE.
    await applySchema()
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

    const holder = new pg.Client({ connectionString: url })
    await holder.connect()
    await holder.query('BEGIN')
    await holder.query(
      `LOCK TABLE ${schema}.relay_assignment_activity_leases IN ACCESS EXCLUSIVE MODE`
    )
    try {
      await applyPostgresSchema(
        relayPostgresSchemaStatements(),
        (statement) => pool.query(statement),
        { catalogQuery: async (sql, params) => (await pool.query(sql, params)).rows }
      )
    } finally {
      await holder.query('ROLLBACK')
      await holder.end()
    }

    const stillThere = await pool.query(
      `SELECT 1 FROM pg_indexes WHERE schemaname = $1 AND indexname = $2`,
      [schema, 'relay_assignment_activity_expiry']
    )
    expect(stillThere.rowCount).toBe(1)

    await applyPostgresSchema(
      relayPostgresSchemaStatements(),
      (statement) => pool.query(statement),
      { catalogQuery: async (sql, params) => (await pool.query(sql, params)).rows }
    )
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


})

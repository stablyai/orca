import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openRelayDatabase, type RelayDatabase } from './database.js'

const databaseUrl = process.env.ORCA_RELAY_TEST_POSTGRES_URL
const describePostgres = databaseUrl ? describe : describe.skip

// Inactive bases outlive their sweep and are never pruned, so the table only
// grows; production reached ~2.24M rows of which 3 were active. Enough rows
// here that a sequential scan is the cheaper plan without the index.
const INACTIVE_ROWS = 20_000
const OWNED_PREFIX = 'sweep-plan-'

describePostgres('PostgreSQL maintenance sweep plans', () => {
  let database: RelayDatabase
  let client: pg.Client

  beforeAll(async () => {
    database = await openRelayDatabase({ databaseUrl, dataDir: '' })
    // Only ever touch this suite's own rows: the database is shared with the
    // other PostgreSQL suites running in parallel.
    await database.query(
      `DELETE FROM relay_connection_bases WHERE basis_conn_id LIKE ?`,
      [`${OWNED_PREFIX}%`]
    )
    await database.query(
      `INSERT INTO relay_connection_bases
       (basis_conn_id, user_id, relay_host_id, relay_device_id,
        owning_control_generation, credential_kind, deadline, active, created_at)
       SELECT '${OWNED_PREFIX}' || generation, 'sweep-plan-user', 'sweepplan01',
              'sweep-plan-device', 1, 'invite', 1000, 0, 1000
       FROM generate_series(1, ${INACTIVE_ROWS}) AS generation`
    )
    await database.query(`ANALYZE relay_connection_bases`)
    client = new pg.Client({ connectionString: databaseUrl })
    await client.connect()
  })

  afterAll(async () => {
    await client.end()
    await database.query(
      `DELETE FROM relay_connection_bases WHERE basis_conn_id LIKE ?`,
      [`${OWNED_PREFIX}%`]
    )
    await database.close()
  })

  // Why: a seq scan here held the maintenance transaction open long enough to
  // time out assignment lock waits fleet-wide (2026-08-05 incident).
  it('matches expired active bases by index instead of scanning the table', async () => {
    const result = await client.query(
      `EXPLAIN UPDATE relay_connection_bases SET active = $1
       WHERE active = $2 AND deadline <= $3`,
      [0, 1, 2000]
    )
    const plan = result.rows.map((row) => String(row['QUERY PLAN'])).join('\n')

    expect(plan).not.toMatch(/Seq Scan on relay_connection_bases/)
    expect(plan).toMatch(/relay_connection_bases_active_deadline/)
  })
})

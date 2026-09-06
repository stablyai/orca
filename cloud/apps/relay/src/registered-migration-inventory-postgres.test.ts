import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openRelayDatabase, type RelayDatabase } from './database.js'
import { REGISTERED_MIGRATION_ABANDON_MS } from './registered-migration-abandonment.js'
import { readRegisteredMigrationInventory } from './registered-migration-inventory.js'

const databaseUrl = process.env.ORCA_RELAY_TEST_POSTGRES_URL
const describePostgres = databaseUrl ? describe : describe.skip
const schema = 'relay_migration_inventory_test'

describePostgres('PostgreSQL registered migration inventory', () => {
  let database: RelayDatabase | undefined

  beforeAll(async () => {
    const client = new pg.Client({ connectionString: databaseUrl })
    await client.connect()
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
      await client.query(`CREATE SCHEMA ${schema}`)
    } finally {
      await client.end()
    }
    const url = new URL(databaseUrl!)
    url.searchParams.set('options', `-c search_path=${schema}`)
    database = await openRelayDatabase({ databaseUrl: url.toString(), dataDir: '' })
  })

  afterAll(async () => {
    await database?.close()
    const client = new pg.Client({ connectionString: databaseUrl })
    await client.connect()
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    } finally {
      await client.end()
    }
  })

  it('counts a disabled-target migration even while its source is active', async () => {
    const now = REGISTERED_MIGRATION_ABANDON_MS + 10_000
    await database!.query(
      `INSERT INTO relay_cells
       (cell_id, cell_url, enabled, capacity_requests, reserved_requests,
        observed_requests, last_heartbeat_at, updated_at)
       VALUES ('cell-a', 'https://a.example.test', 1, 4000, 1, 0, 0, 1),
              ('cell-b', 'https://b.example.test', 0, 4000, 0, 0, 0, 1)`
    )
    await database!.query(
      `INSERT INTO relay_cell_admission (cell_id, admission_state, updated_at)
       VALUES ('cell-a', 'general', 1), ('cell-b', 'existing-only', 1)`
    )
    await database!.query(
      `INSERT INTO relay_assignments
       (user_id, relay_host_id, cell_id, assignment_epoch, lease_expires_at,
        last_activity_at, reserved_controls, reserved_splices, reserved_invites,
        pending_installs, pending_confirmations, migration_leases)
       VALUES ('user-1', '111111111111', 'cell-b', 2, ?, ?, 0, 0, 0, 0, 0, 0)`,
      [now, now]
    )
    await database!.query(
      `INSERT INTO relay_assignment_activity_leases
       (user_id, relay_host_id, activity_id, activity_kind, cell_id,
        request_units, expires_at, updated_at)
       VALUES ('user-1', '111111111111', 'control:source:1', 'control', 'cell-a', 1, ?, ?)`,
      [now, now]
    )
    await database!.query(
      `INSERT INTO relay_assignment_migrations
       (user_id, relay_host_id, source_cell_id, target_cell_id, previous_epoch,
        assignment_epoch, source_request_units, target_reserved_units, expires_at,
        target_registered_at, created_at, updated_at)
       VALUES ('user-1', '111111111111', 'cell-a', 'cell-b', 1, 2, 1, 2, 2, 2, 1, 2)`
    )

    expect(await readRegisteredMigrationInventory(database!, now)).toEqual({
      open: 1,
      inactive: 1,
      abandoned: 1,
      pairs: [
        {
          sourceCellId: 'cell-a',
          targetCellId: 'cell-b',
          open: 1,
          inactive: 1,
          abandoned: 1
        }
      ]
    })

    await database!.query(
      `INSERT INTO relay_cells
       (cell_id, cell_url, enabled, capacity_requests, reserved_requests,
        observed_requests, last_heartbeat_at, updated_at)
       VALUES ('cell-c', 'https://c.example.test', 1, 4000, 0, 0, 0, 1)`
    )
    await database!.query(
      `INSERT INTO relay_cell_admission (cell_id, admission_state, updated_at)
       VALUES ('cell-c', 'migration-only', 1)`
    )
    await database!.query(
      `INSERT INTO relay_assignments
       (user_id, relay_host_id, cell_id, assignment_epoch, lease_expires_at,
        last_activity_at, reserved_controls, reserved_splices, reserved_invites,
        pending_installs, pending_confirmations, migration_leases)
       VALUES ('user-2', '222222222222', 'cell-c', 2, ?, ?, 0, 0, 0, 0, 0, 0)`,
      [now, now]
    )
    await database!.query(
      `INSERT INTO relay_assignment_migrations
       (user_id, relay_host_id, source_cell_id, target_cell_id, previous_epoch,
        assignment_epoch, source_request_units, target_reserved_units, expires_at,
        target_registered_at, created_at, updated_at)
       VALUES ('user-2', '222222222222', 'cell-a', 'cell-c', 1, 2, 1, 2, ?, NULL, 1, 2)`,
      [now + 60_000]
    )

    expect(await readRegisteredMigrationInventory(database!, now)).toEqual({
      open: 2,
      inactive: 1,
      abandoned: 1,
      pairs: [
        {
          sourceCellId: 'cell-a',
          targetCellId: 'cell-b',
          open: 1,
          inactive: 1,
          abandoned: 1
        },
        {
          sourceCellId: 'cell-a',
          targetCellId: 'cell-c',
          open: 1,
          inactive: 0,
          abandoned: 0
        }
      ]
    })
  })
})

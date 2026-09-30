import { describe, expect, it } from 'vitest'
import { openInMemoryRelayDatabase, type RelayDatabase } from './database.js'
import { REGISTERED_MIGRATION_ABANDON_MS } from './registered-migration-abandonment.js'
import {
  formatRegisteredMigrationInventory,
  readRegisteredMigrationInventory
} from './registered-migration-inventory.js'

describe('registered migration inventory', () => {
  it('does not restart abandonment when an old source migration lease is refreshed', async () => {
    const database = await openInMemoryRelayDatabase()
    const now = REGISTERED_MIGRATION_ABANDON_MS + 10_000
    await insertCell(database, 'cell-a', false, 'existing-only')
    await insertCell(database, 'cell-b', true, 'migration-only')
    await insertMigration(database, now - 1)

    const fresh = await readRegisteredMigrationInventory(database, now)

    expect(fresh).toEqual({
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
    expect(formatRegisteredMigrationInventory(fresh)).toEqual([
      '[orca-relay] migration inventory open=1 expiredRegisteredInactive=1 abandonedRegistered=1',
      '[orca-relay] migration pair sourceCellId=cell-a targetCellId=cell-b open=1 expiredRegisteredInactive=1 abandoned=1'
    ])
    expect(
      (
        await readRegisteredMigrationInventory(
          database,
          now + 1
        )
      ).abandoned
    ).toBe(1)
  })

  it('includes unregistered open migrations without logging a host identity', async () => {
    const database = await openInMemoryRelayDatabase()
    const now = 10_000
    await insertCell(database, 'cell-a', false, 'existing-only')
    await insertCell(database, 'cell-b', true, 'migration-only')
    await insertMigration(database, now + 60_000, null)

    const inventory = await readRegisteredMigrationInventory(database, now)

    expect(inventory).toEqual({
      open: 1,
      inactive: 0,
      abandoned: 0,
      pairs: [
        {
          sourceCellId: 'cell-a',
          targetCellId: 'cell-b',
          open: 1,
          inactive: 0,
          abandoned: 0
        }
      ]
    })
    expect(formatRegisteredMigrationInventory(inventory).join('\n')).not.toContain(
      '111111111111'
    )
  })
})

async function insertCell(
  database: RelayDatabase,
  cellId: string,
  enabled: boolean,
  admissionState: string
): Promise<void> {
  await database.query(
    `INSERT INTO relay_cells
     (cell_id, cell_url, enabled, capacity_requests, reserved_requests,
      observed_requests, last_heartbeat_at, updated_at)
     VALUES (?, ?, ?, 4000, 0, 0, 0, 1)`,
    [cellId, `https://${cellId}.example.test`, enabled ? 1 : 0]
  )
  await database.query(
    `INSERT INTO relay_cell_admission (cell_id, admission_state, updated_at)
     VALUES (?, ?, 1)`,
    [cellId, admissionState]
  )
}

async function insertMigration(
  database: RelayDatabase,
  expiresAt: number,
  targetRegisteredAt: number | null = 2
): Promise<void> {
  await database.query(
    `INSERT INTO relay_assignments
     (user_id, relay_host_id, cell_id, assignment_epoch, lease_expires_at,
      last_activity_at, reserved_controls, reserved_splices, reserved_invites,
      pending_installs, pending_confirmations, migration_leases)
     VALUES ('user-1', '111111111111', 'cell-b', 2, ?, ?, 0, 0, 0, 0, 0, 0)`,
    [expiresAt, expiresAt]
  )
  await database.query(
    `INSERT INTO relay_assignment_migrations
     (user_id, relay_host_id, source_cell_id, target_cell_id, previous_epoch,
      assignment_epoch, source_request_units, target_reserved_units, expires_at,
      target_registered_at, created_at, updated_at)
     VALUES ('user-1', '111111111111', 'cell-a', 'cell-b', 1, 2, 1, 2, ?, ?, 1, 2)`,
    [expiresAt, targetRegisteredAt]
  )
}

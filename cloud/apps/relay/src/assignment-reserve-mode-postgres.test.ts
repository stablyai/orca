import { randomUUID } from 'node:crypto'
import { ASSIGNMENT_LIMITS } from '@orca-cloud/relay-contract'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { RelayAssignmentStore } from './assignment-store.js'
import type { RelayCellConfig } from './config.js'
import { openRelayDatabase, type RelayDatabase } from './database.js'

// The step-5 census on real PostgreSQL: every new statement (the admit-mode table, the
// open-flow check under FOR UPDATE, the live-reserve pin) must run there, not only on SQLite.

const databaseUrl = process.env.ORCA_RELAY_TEST_POSTGRES_URL
const describePostgres = databaseUrl ? describe : describe.skip

const run = randomUUID().slice(0, 8)
const cellA: RelayCellConfig = { id: `census-pg-a-${run}`, url: `https://census-a-${run}.example.com`, capacityRequests: 10, connectionHardCap: 600, connectionUnobservedBound: 50 }
const cellB: RelayCellConfig = { id: `census-pg-b-${run}`, url: `https://census-b-${run}.example.com`, capacityRequests: 10, connectionHardCap: 600, connectionUnobservedBound: 50 }
const USER = `census-pg-${run}`

describePostgres('reserve-mode census on PostgreSQL', () => {
  let database: RelayDatabase

  beforeAll(async () => {
    database = await openRelayDatabase({ databaseUrl, dataDir: '/tmp' })
  })

  afterAll(async () => {
    for (const table of ['relay_assignment_activity_leases', 'relay_assignment_migrations', 'relay_assignments']) {
      await database.query(`DELETE FROM ${table} WHERE user_id = ?`, [USER])
    }
    for (const cell of [cellA, cellB]) {
      for (const table of ['relay_cell_admit_modes', 'relay_cell_admission', 'relay_cell_regions', 'relay_cell_runtime', 'relay_cells']) {
        await database.query(`DELETE FROM ${table} WHERE cell_id = ?`, [cell.id])
      }
    }
    await database.close()
  })

  const heartbeat = async (store: RelayAssignmentStore, cell: RelayCellConfig) =>
    await store.recordCellHeartbeat({
      cellId: cell.id,
      cellUrl: cell.url,
      cellIncarnation: '11111111-1111-4111-8111-111111111111',
      startedAt: 50,
      ready: true,
      observedRequests: 0,
      totalConnections: 0,
      inFlightConnections: 0,
      reservedConnectionUnits: 0,
      enforcedConnectionUnits: 0,
      connectionHardCap: 600,
      connectionUnobservedBound: 50
    })

  it('flips a cell to reserve and back, and refuses reserve while a migration names it', async () => {
    const store = new RelayAssignmentStore(database, () => 1_000)
    await store.reconcileCells([cellA, cellB], false)
    await store.setCellAdmitMode(cellA.id, 'reserve')
    expect(await store.cellAdmitMode(cellA.id)).toEqual({ admitMode: 'reserve', updatedAt: 1_000 })
    expect([...((await store.reserveModeCells()) ?? [])]).toContain(cellA.id)
    await store.setCellAdmitMode(cellA.id, 'db')
    expect(await store.cellAdmitMode(cellA.id)).toMatchObject({ admitMode: 'db' })
    await database.query(
      `INSERT INTO relay_assignment_migrations
       (user_id, relay_host_id, source_cell_id, target_cell_id, previous_epoch, assignment_epoch,
        source_request_units, target_reserved_units, expires_at, created_at, updated_at)
       VALUES (?, 'host000000000009', ?, ?, 1, 2, 0, 1, 9999, 1000, 1000)`,
      [USER, cellB.id, cellA.id]
    )
    await expect(store.setCellAdmitMode(cellA.id, 'reserve')).rejects.toThrow('cell_has_open_migration')
    await database.query(`DELETE FROM relay_assignment_migrations WHERE user_id = ?`, [USER])
    await store.setCellAdmitMode(cellA.id, 'reserve')
    await store.setCellAdmitMode(cellA.id, 'db')
  })

  it('pins a host on a live reserve cell without writing its rows, and re-places it once that cell is dead', async () => {
    let now = 100_000
    const store = new RelayAssignmentStore(database, () => now, { requireLiveCells: true, heartbeatTtlMs: 45_000 })
    await store.reconcileCells([cellA, cellB], false)
    await heartbeat(store, cellA)
    await heartbeat(store, cellB)
    expect(await store.cellHeartbeatFresh(cellA.id)).toBe(true)
    const identity = { userId: USER, relayHostId: 'host000000000001' }
    await database.query(
      `INSERT INTO relay_assignments
       (user_id, relay_host_id, cell_id, assignment_epoch, lease_expires_at, last_activity_at,
        reserved_controls, reserved_splices, reserved_invites, pending_installs,
        pending_confirmations, migration_leases)
       VALUES (?, ?, ?, 4, ?, ?, 0, 0, 0, 0, 0, 0)`,
      [USER, identity.relayHostId, cellA.id, now, now]
    )
    await store.setCellAdmitMode(cellA.id, 'reserve')
    now += ASSIGNMENT_LIMITS.activityLeaseMs + ASSIGNMENT_LIMITS.dormantTtlMs + 1
    await heartbeat(store, cellA)
    await heartbeat(store, cellB)
    const reservedBefore = await database.query(`SELECT reserved_requests FROM relay_cells WHERE cell_id = ?`, [cellA.id])
    expect(await store.assign(identity)).toMatchObject({ cellId: cellA.id, assignmentEpoch: 4 })
    expect(await database.query(`SELECT reserved_requests FROM relay_cells WHERE cell_id = ?`, [cellA.id])).toEqual(
      reservedBefore
    )
    expect(
      await database.query(`SELECT activity_id FROM relay_assignment_activity_leases WHERE user_id = ?`, [USER])
    ).toEqual([])
    // cellA stops heartbeating: a dead cell holds no duplicate, so the host is re-placed.
    now += 60_000
    await heartbeat(store, cellB)
    expect(await store.cellHeartbeatFresh(cellA.id)).toBe(false)
    expect((await store.assign(identity)).cellId).toBe(cellB.id)
    await store.setCellAdmitMode(cellA.id, 'db')
  })
})

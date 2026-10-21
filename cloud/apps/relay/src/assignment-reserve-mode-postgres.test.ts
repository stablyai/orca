import { randomUUID } from 'node:crypto'
import { ASSIGNMENT_LIMITS } from '@orca-cloud/relay-contract'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CELL_ADMIT_EFFECTIVE_FRESH_MS, RelayAssignmentStore } from './assignment-store.js'
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
      for (const table of ['relay_cell_admit_effective', 'relay_cell_admit_modes', 'relay_cell_admission', 'relay_cell_regions', 'relay_cell_runtime', 'relay_cells']) {
        await database.query(`DELETE FROM ${table} WHERE cell_id = ?`, [cell.id])
      }
    }
    await database.close()
  })

  const heartbeat = async (store: RelayAssignmentStore, cell: RelayCellConfig, ready = true) =>
    await store.recordCellHeartbeat({
      cellId: cell.id,
      cellUrl: cell.url,
      cellIncarnation: '11111111-1111-4111-8111-111111111111',
      startedAt: 50,
      ready,
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

  // A database brownout drops ready, not the socket: a host on a reserve cell that still
  // heartbeats is not re-placed (that would seat it twice); its home just reads unavailable.
  it('does not re-place a host off a reserve cell that heartbeats while not ready', async () => {
    let now = 400_000
    const store = new RelayAssignmentStore(database, () => now, { requireLiveCells: true, heartbeatTtlMs: 45_000 })
    await store.reconcileCells([cellA, cellB], false)
    const identity = { userId: USER, relayHostId: 'host000000000005' }
    await database.query(
      `INSERT INTO relay_assignments
       (user_id, relay_host_id, cell_id, assignment_epoch, lease_expires_at, last_activity_at,
        reserved_controls, reserved_splices, reserved_invites, pending_installs,
        pending_confirmations, migration_leases)
       VALUES (?, ?, ?, 7, ?, ?, 0, 0, 0, 0, 0, 0)`,
      [USER, identity.relayHostId, cellA.id, now, now]
    )
    await store.setCellAdmitMode(cellA.id, 'reserve')
    now += ASSIGNMENT_LIMITS.activityLeaseMs + ASSIGNMENT_LIMITS.dormantTtlMs + 1
    await heartbeat(store, cellA, false)
    await heartbeat(store, cellB)
    await expect(store.assign(identity)).rejects.toThrow('relay_home_cell_unavailable')
    expect(
      await database.query(`SELECT cell_id FROM relay_assignments WHERE user_id = ? AND relay_host_id = ?`, [
        USER,
        identity.relayHostId
      ])
    ).toEqual([{ cell_id: cellA.id }])
    await store.setCellAdmitMode(cellA.id, 'db')
  })

  // A fleet-wide dead-man trip leaves every cell reserve in PG, and no director writes db back.
  // The database path places on a reserve cell only by that cell's own fresh row saying db.
  it('places a fresh host on a reserve cell only while its own current-process row says db', async () => {
    let now = 200_000
    const fresh = () => new RelayAssignmentStore(database, () => now)
    const setup = fresh()
    await setup.reconcileCells([cellA, cellB], false)
    await heartbeat(setup, cellA)
    await heartbeat(setup, cellB)
    await setup.setCellAdmitMode(cellA.id, 'reserve')
    await setup.setCellAdmitMode(cellB.id, 'reserve')
    // An older cell image writes no row: never admitted.
    await expect(fresh().assign({ userId: USER, relayHostId: 'host000000000002' })).rejects.toThrow(
      'relay_capacity_exhausted'
    )
    // A row from another process (a restarted cell's predecessor) does not count either.
    await setup.recordCellAdmitEffective({ cellId: cellB.id, cellIncarnation: '22222222-2222-4222-8222-222222222222', mode: 'db' })
    await setup.recordCellAdmitEffective({ cellId: cellA.id, cellIncarnation: '11111111-1111-4111-8111-111111111111', mode: 'reserve' })
    await expect(fresh().assign({ userId: USER, relayHostId: 'host000000000002' })).rejects.toThrow(
      'relay_capacity_exhausted'
    )
    await setup.recordCellAdmitEffective({ cellId: cellA.id, cellIncarnation: '11111111-1111-4111-8111-111111111111', mode: 'db' })
    const store = fresh()
    expect((await store.assign({ userId: USER, relayHostId: 'host000000000003' })).cellId).toBe(cellA.id)
    // Census sweeps still treat it as reserve.
    expect([...((await store.reserveModeCells()) ?? [])]).toEqual(expect.arrayContaining([cellA.id, cellB.id]))
    // Three missed 15 s refreshes and the row counts for nothing.
    now += CELL_ADMIT_EFFECTIVE_FRESH_MS + 1
    await heartbeat(setup, cellA)
    await expect(fresh().assign({ userId: USER, relayHostId: 'host000000000006' })).rejects.toThrow(
      'relay_capacity_exhausted'
    )
    await setup.setCellAdmitMode(cellA.id, 'db')
    await setup.setCellAdmitMode(cellB.id, 'db')
  })

  // A timed-out read inside BEGIN aborts the transaction (25P02 on the next statement), so the
  // reserve set is read before BEGIN and the transaction answers from that read.
  it('assigns while the admit-mode read times out (57014), without aborting the transaction', async () => {
    const timed = await openRelayDatabase({ databaseUrl, dataDir: '/tmp', statementTimeoutMs: 300 })
    const holder = await openRelayDatabase({ databaseUrl, dataDir: '/tmp' })
    let release!: () => void
    const released = new Promise<void>((resolve) => (release = resolve))
    let held!: () => void
    const holding = new Promise<void>((resolve) => (held = resolve))
    const lock = holder.transaction(async (transaction) => {
      await transaction.query(`LOCK TABLE relay_cell_admit_modes IN ACCESS EXCLUSIVE MODE`)
      held()
      await released
    })
    try {
      await holding
      const store = new RelayAssignmentStore(timed, () => 300_000)
      await store.reconcileCells([cellA, cellB], false)
      await heartbeat(store, cellA)
      await heartbeat(store, cellB)
      expect(await store.reserveModeCells()).toBeNull()
      const placed = await store.assign({ userId: USER, relayHostId: 'host000000000004' })
      expect([cellA.id, cellB.id]).toContain(placed.cellId)
    } finally {
      release()
      await lock
      await timed.close()
      await holder.close()
    }
  }, 20_000)

  // A stall must not double connection demand: concurrent assigns share one reserve-set read,
  // and after it fails the last answer stands for the backoff without another query.
  it('reads the reserve set once for concurrent assigns during a stall, and not again in the backoff', async () => {
    const timed = await openRelayDatabase({ databaseUrl, dataDir: '/tmp', statementTimeoutMs: 300 })
    const holder = await openRelayDatabase({ databaseUrl, dataDir: '/tmp' })
    let release!: () => void
    const released = new Promise<void>((resolve) => (release = resolve))
    let held!: () => void
    const holding = new Promise<void>((resolve) => (held = resolve))
    const lock = holder.transaction(async (transaction) => {
      await transaction.query(`LOCK TABLE relay_cell_admit_modes IN ACCESS EXCLUSIVE MODE`)
      held()
      await released
    })
    try {
      await holding
      const store = new RelayAssignmentStore(timed, () => 500_000)
      await store.reconcileCells([cellA, cellB], false)
      await heartbeat(store, cellA)
      await heartbeat(store, cellB)
      const query = timed.query.bind(timed)
      let reads = 0
      timed.query = async (sql, params) => {
        if (sql.includes('FROM relay_cell_admit_modes m')) reads += 1
        return await query(sql, params)
      }
      const placed = await Promise.all(
        Array.from({ length: 6 }, async (_, index) =>
          await store.assign({ userId: USER, relayHostId: `hoststall0000${String(index).padStart(3, '0')}` })
        )
      )
      expect(placed).toHaveLength(6)
      expect(reads).toBe(1)
      await store.assign({ userId: USER, relayHostId: 'hoststall0000100' })
      expect(await store.reserveModeCells()).toBeNull()
      expect(reads).toBe(1)
    } finally {
      release()
      await lock
      await timed.close()
      await holder.close()
    }
  }, 20_000)
})


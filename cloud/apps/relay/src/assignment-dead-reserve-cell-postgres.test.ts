import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { RelayAssignmentStore } from './assignment-store.js'
import type { RelayCellConfig } from './config.js'
import { openRelayDatabase, type RelayDatabase } from './database.js'
import { ReserveLedgerWriter } from './reserve-ledger-writer.js'

// A host that lost its control leaves a capped reserve cell this director proves dead (stale
// heartbeat + its own polls unanswered) without an operator fence; every live-cell case keeps it.

const databaseUrl = process.env.ORCA_RELAY_TEST_POSTGRES_URL
const describePostgres = databaseUrl ? describe : describe.skip

const HEARTBEAT_TTL_MS = 45_000
const run = randomUUID().slice(0, 8)
const capped = (id: string): RelayCellConfig => ({
  id: `${id}-${run}`,
  url: `https://${id}-${run}.example.com`,
  capacityRequests: 10,
  connectionHardCap: 600,
  connectionUnobservedBound: 50
})
const dead = capped('dead-reserve-a')
const live = capped('dead-reserve-b')
const USER = `dead-reserve-${run}`
const INCARNATION = '11111111-1111-4111-8111-111111111111'

describePostgres('a host leaving a dead reserve cell, on PostgreSQL', () => {
  let database: RelayDatabase
  let now: number
  let pollsDead: boolean
  let store: RelayAssignmentStore
  let hostSerial = 0

  beforeAll(async () => {
    database = await openRelayDatabase({ databaseUrl, dataDir: '/tmp' })
  })

  afterAll(async () => {
    for (const table of [
      'relay_post_drain_migration_pins',
      'relay_assignment_activity_leases',
      'relay_assignment_migrations',
      'relay_assignments'
    ]) {
      await database.query(`DELETE FROM ${table} WHERE user_id = ?`, [USER])
    }
    for (const cell of [dead, live]) {
      for (const table of [
        'relay_cell_admit_effective',
        'relay_cell_admit_modes',
        'relay_cell_admission',
        'relay_cell_connection_limits',
        'relay_cell_regions',
        'relay_cell_runtime',
        'relay_cells'
      ]) {
        await database.query(`DELETE FROM ${table} WHERE cell_id = ?`, [cell.id])
      }
    }
    await database.close()
  })

  const heartbeat = async (cell: RelayCellConfig, ready = true) =>
    await store.recordCellHeartbeat({
      cellId: cell.id,
      cellUrl: cell.url,
      cellIncarnation: INCARNATION,
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

  // The step-5 ledger mirror: a row at `epoch` with no units, as the director writes for a booked join.
  const ledgerRow = async (relayHostId: string, epoch: number) =>
    await database.query(
      `INSERT INTO relay_assignments
       (user_id, relay_host_id, cell_id, assignment_epoch, lease_expires_at, last_activity_at,
        reserved_controls, reserved_splices, reserved_invites, pending_installs,
        pending_confirmations, migration_leases)
       VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 0, 0)`,
      [USER, relayHostId, dead.id, epoch, now, now]
    )

  const rowOf = async (relayHostId: string) =>
    (
      await database.query(
        `SELECT cell_id, CAST(assignment_epoch AS INTEGER) AS assignment_epoch FROM relay_assignments WHERE user_id = ? AND relay_host_id = ?`,
        [USER, relayHostId]
      )
    )[0]

  const leasesOf = async (relayHostId: string) =>
    await database.query(
      `SELECT cell_id FROM relay_assignment_activity_leases WHERE user_id = ? AND relay_host_id = ?`,
      [USER, relayHostId]
    )

  const reservedOn = async (cell: RelayCellConfig) =>
    (await database.query(`SELECT reserved_requests FROM relay_cells WHERE cell_id = ?`, [cell.id]))[0]

  // The dead cell stopped heartbeating at `now`; only the live one keeps going.
  const killDeadCell = async () => {
    now += HEARTBEAT_TTL_MS + 15_000
    await heartbeat(live)
  }

  // As the step-5 plan hands it over: every epoch the director's map knows for the host.
  const hostAssign = async (relayHostId: string, hostRequested = true, epochFloor: number | null = 0) =>
    await store.assign({ userId: USER, relayHostId }, undefined, undefined, undefined, {
      hostRequested,
      ...(epochFloor === null ? {} : { epochFloor })
    })

  const nextHost = () => `host${run}${String(++hostSerial).padStart(4, '0')}`

  beforeEach(async () => {
    now = 1_000_000 + hostSerial * 1_000_000
    pollsDead = true
    store = new RelayAssignmentStore(database, () => now, {
      requireLiveCells: true,
      heartbeatTtlMs: HEARTBEAT_TTL_MS,
      deadCellVerdict: (cellId) =>
        pollsDead && cellId === dead.id
          ? { dead: true, fleetFailing: 1, fleetPolled: 34, regionFailing: 1, regionPolled: 28 }
          : null
    })
    await store.reconcileCells([dead, live], false)
    await heartbeat(dead)
    await heartbeat(live)
    await store.setCellAdmitMode(dead.id, 'db')
  })

  it('§8a: the dead-man re-registered the hosts (rows + leases), then the cell died: they move, epoch+1, leases gone', async () => {
    const host = nextHost()
    await ledgerRow(host, 4)
    await store.setCellAdmitMode(dead.id, 'reserve')
    const reservedBefore = await reservedOn(dead)
    // The trip's re-registration: the lease the memory admit never took.
    const { reservationDelta } = await store.activateControlDeferringCell(
      { userId: USER, relayHostId: host },
      { cellId: dead.id, assignmentEpoch: 4, generation: 1, cellIncarnation: INCARNATION }
    )
    await store.commitCellReservationDelta(dead.id, reservationDelta)
    expect(await leasesOf(host)).toEqual([{ cell_id: dead.id }])
    await killDeadCell()

    const moved = await hostAssign(host)
    expect(moved).toMatchObject({ cellId: live.id, assignmentEpoch: 5 })
    expect(await rowOf(host)).toEqual({ cell_id: live.id, assignment_epoch: 5 })
    expect((await leasesOf(host)).every((lease) => lease['cell_id'] === live.id)).toBe(true)
    expect(await reservedOn(dead)).toEqual(reservedBefore)
  })

  it('hard crash with no dead-man trip: a ledger-only row moves too', async () => {
    const host = nextHost()
    await ledgerRow(host, 7)
    await store.setCellAdmitMode(dead.id, 'reserve')
    await killDeadCell()
    expect(await hostAssign(host)).toMatchObject({ cellId: live.id, assignmentEpoch: 8 })
  })

  it('a seat ahead of the row: the move mints above it, and the revived cell\'s seat never wins the row back', async () => {
    const host = nextHost()
    await ledgerRow(host, 4)
    await store.setCellAdmitMode(dead.id, 'reserve')
    await killDeadCell()
    // The map saw a later booking on the dead cell at 6 that the ledger never wrote.
    expect(await hostAssign(host, true, 6)).toMatchObject({ cellId: live.id, assignmentEpoch: 7 })
    // The cell revives in the same incarnation still holding that seat; the ledger mirror and the
    // reconcile write it with the strict guard.
    const ledger = new ReserveLedgerWriter(database, { now: () => now, log: () => undefined })
    for (const epoch of [6, 7]) ledger.enqueue({ userId: USER, relayHostId: host, cellId: dead.id, epoch })
    await ledger.flush()
    expect(ledger.pending()).toBe(0)
    expect(await rowOf(host)).toEqual({ cell_id: live.id, assignment_epoch: 7 })
  })

  it('without the step-5 plan\'s epoch floor (placement off), the fence is kept', async () => {
    const host = nextHost()
    await ledgerRow(host, 3)
    await store.setCellAdmitMode(dead.id, 'reserve')
    await killDeadCell()
    await expect(hostAssign(host, true, null)).rejects.toThrow('relay_home_cell_unavailable')
  })

  it('a withheld verdict (fleet or region guard) keeps the fence', async () => {
    const host = nextHost()
    await ledgerRow(host, 3)
    await store.setCellAdmitMode(dead.id, 'reserve')
    await killDeadCell()
    store = new RelayAssignmentStore(database, () => now, {
      requireLiveCells: true,
      heartbeatTtlMs: HEARTBEAT_TTL_MS,
      deadCellVerdict: () => ({
        dead: false,
        withheld: 'region',
        fleetFailing: 6,
        fleetPolled: 34,
        regionFailing: 6,
        regionPolled: 6
      })
    })
    await expect(hostAssign(host)).rejects.toThrow('relay_home_cell_unavailable')
  })

  // Only a heartbeat that stopped (cause 'unheard') is death; polls failing for 45 s add nothing else.
  it('a cell heartbeating but not ready keeps its hosts, however long its polls fail', async () => {
    const host = nextHost()
    await ledgerRow(host, 3)
    await store.setCellAdmitMode(dead.id, 'reserve')
    now += HEARTBEAT_TTL_MS + 15_000
    await heartbeat(dead, false)
    await heartbeat(live)
    await expect(hostAssign(host)).rejects.toThrow('relay_home_cell_unavailable')
    expect(await rowOf(host)).toEqual({ cell_id: dead.id, assignment_epoch: 3 })
  })

  it('drain then death keeps the fence: a disabled cell is draining, not unheard', async () => {
    const host = nextHost()
    await ledgerRow(host, 3)
    await store.setCellAdmitMode(dead.id, 'reserve')
    await database.query(`UPDATE relay_cells SET enabled = 0 WHERE cell_id = ?`, [dead.id])
    try {
      await killDeadCell()
      await expect(hostAssign(host)).rejects.toThrow('relay_home_cell_unavailable')
      expect(await rowOf(host)).toEqual({ cell_id: dead.id, assignment_epoch: 3 })
    } finally {
      await database.query(`UPDATE relay_cells SET enabled = 1 WHERE cell_id = ?`, [dead.id])
    }
  })

  it('LB drain: heartbeat fresh while polls fail, so the host is pinned to its cell', async () => {
    const host = nextHost()
    await ledgerRow(host, 3)
    await store.setCellAdmitMode(dead.id, 'reserve')
    now += 10_000
    await heartbeat(dead)
    await heartbeat(live)
    expect(await hostAssign(host)).toMatchObject({ cellId: dead.id, assignmentEpoch: 3 })
    expect(await rowOf(host)).toEqual({ cell_id: dead.id, assignment_epoch: 3 })
  })

  it('DB outage or director freeze: heartbeat stale but polls answered (no verdict), so 503', async () => {
    const host = nextHost()
    await ledgerRow(host, 3)
    await store.setCellAdmitMode(dead.id, 'reserve')
    await killDeadCell()
    pollsDead = false
    await expect(hostAssign(host)).rejects.toThrow('relay_home_cell_unavailable')
    expect(await rowOf(host)).toEqual({ cell_id: dead.id, assignment_epoch: 3 })
  })

  it('a sweep (not the host asking) keeps requiring the fence', async () => {
    const host = nextHost()
    await ledgerRow(host, 3)
    await store.setCellAdmitMode(dead.id, 'reserve')
    await killDeadCell()
    await expect(hostAssign(host, false)).rejects.toThrow('relay_home_cell_unavailable')
    expect(await store.evacuateDeadCells()).toBe(0)
    expect(await rowOf(host)).toEqual({ cell_id: dead.id, assignment_epoch: 3 })
  })

  it('reserve only: a capped db-mode cell keeps the fence (autoheal returns it with its hosts)', async () => {
    const host = nextHost()
    await ledgerRow(host, 3)
    await killDeadCell()
    await expect(hostAssign(host)).rejects.toThrow('relay_home_cell_unavailable')
  })

  it('a post-drain migration pin keeps requiring the fence', async () => {
    const host = nextHost()
    await ledgerRow(host, 3)
    await database.query(
      `INSERT INTO relay_assignment_migrations
       (user_id, relay_host_id, source_cell_id, target_cell_id, previous_epoch, assignment_epoch,
        source_request_units, target_reserved_units, expires_at, target_registered_at,
        completed_at, aborted_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 2, 3, 0, 1, ?, NULL, NULL, NULL, ?, ?)`,
      [USER, host, live.id, dead.id, now + 3_600_000, now, now]
    )
    await database.query(
      `INSERT INTO relay_post_drain_migration_pins
       (user_id, relay_host_id, assignment_epoch, drain_attempt_id, source_cell_id,
        source_cell_incarnation, target_cell_id, target_cell_incarnation, source_request_units,
        target_reserved_units, pinned_at)
       VALUES (?, ?, 3, ?, ?, ?, ?, ?, 0, 1, ?)`,
      [USER, host, `attempt-${run}`, live.id, INCARNATION, dead.id, INCARNATION, now]
    )
    // Reserve is refused while a migration names the cell, so the mode is set underneath it.
    await database.query(
      `INSERT INTO relay_cell_admit_modes (cell_id, admit_mode, updated_at) VALUES (?, 'reserve', ?)
       ON CONFLICT (cell_id) DO UPDATE SET admit_mode = 'reserve', updated_at = excluded.updated_at`,
      [dead.id, now]
    )
    await killDeadCell()
    await expect(hostAssign(host)).rejects.toThrow('relay_home_cell_unavailable')
    await database.query(`DELETE FROM relay_post_drain_migration_pins WHERE user_id = ? AND relay_host_id = ?`, [
      USER,
      host
    ])
    await database.query(`DELETE FROM relay_assignment_migrations WHERE user_id = ? AND relay_host_id = ?`, [
      USER,
      host
    ])
  })
})

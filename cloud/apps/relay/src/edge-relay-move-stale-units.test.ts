import { afterEach, describe, expect, it, vi } from 'vitest'
import { RelayAssignmentStore } from './assignment/assignment-store.js'
import type { RelayCellConfig } from './config.js'
import { openInMemoryRelayDatabase, type RelayDatabase } from './database.js'
import type { EdgeAdmin, EdgeAssignBody } from './edge-admin-client.js'
import { edgeMoveOwnControlAsk, edgeMoveStaleUnitsAsk, parseEdgeControl, type EdgeControlFlags } from './edge-relay-control.js'
import { EDGE_CELL_ID, EdgeAssignments, EdgeMoveDeferredError } from './edge-relay.js'

const EDGE_URL = 'https://edge.relay.example.com'
const GCE_CELL: RelayCellConfig = { id: 'production-gce-c7', url: 'https://c7.relay.example.com', capacityRequests: 1_000 }
const IDENTITY = { userId: 'user-1', relayHostId: 'stalehost0000001' }
const INCARNATION = '22222222-2222-4222-8222-222222222222'
const RESERVE = new Set([GCE_CELL.id])

describe('moveOwnControl drain-stale flag', () => {
  it('parses drain-stale', () => {
    expect(parseEdgeControl({ v: 1, flags: { moveOwnControl: 'drain-stale' } })).toEqual({
      flags: { mode: 'on', moveOwnControl: 'drain-stale' },
      ignoredKeys: []
    })
  })

  it('qualifies the same asks as drain, and only drain-stale qualifies stale moves', () => {
    const asks = [{ reconnect: true }, { reconnect: true, regionCorrection: { v: 1 } }, {}]
    const own = (moveOwnControl: EdgeControlFlags['moveOwnControl']) =>
      asks.map((ask) => edgeMoveOwnControlAsk({ mode: 'on', moveOwnControl }, ask))
    const stale = (moveOwnControl: EdgeControlFlags['moveOwnControl']) =>
      asks.map((ask) => edgeMoveStaleUnitsAsk({ mode: 'on', moveOwnControl }, ask))
    expect(own('drain-stale')).toEqual([true, false, false])
    expect(stale('drain-stale')).toEqual([true, false, false])
    expect(stale('drain')).toEqual([false, false, false])
    expect(stale('off')).toEqual([false, false, false])
  })
})

describe('edge move past stale unleased counters on a reserve-mode cell', () => {
  const databases: RelayDatabase[] = []
  afterEach(async () => {
    vi.restoreAllMocks()
    for (const database of databases.splice(0)) { await database.close() }
  })

  async function setup() {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const database = await openInMemoryRelayDatabase()
    databases.push(database)
    const now = 1_000
    const store = new RelayAssignmentStore(database, () => now, { requireLiveCells: true, heartbeatTtlMs: 45_000 })
    await store.reconcileCells([GCE_CELL], true)
    await store.recordCellHeartbeat({
      cellId: GCE_CELL.id,
      cellUrl: GCE_CELL.url,
      cellIncarnation: INCARNATION,
      startedAt: 500,
      ready: true,
      observedRequests: 0
    })
    const pushes: EdgeAssignBody[] = []
    const admin = {
      assign: async (body: EdgeAssignBody) => {
        pushes.push(body)
        return { outcome: 'applied' as const, assignmentEpoch: body.assignmentEpoch }
      }
    } as unknown as EdgeAdmin
    const edge = new EdgeAssignments(
      database,
      { cellUrl: EDGE_URL, rolloutPercent: 0, allowHosts: new Set(), denyHosts: new Set(), regions: new Set(['us-central1']) },
      () => now,
      admin
    )
    await edge.ensureEdgeCell()
    const placed = await store.assign(IDENTITY)
    expect(placed.cellId).toBe(GCE_CELL.id)
    // What a reserve-mode cell leaves behind: counters from before it admitted from memory, no lease.
    await database.query(`DELETE FROM relay_assignment_activity_leases WHERE relay_host_id = ?`, [IDENTITY.relayHostId])
    await database.query(
      `UPDATE relay_assignments SET reserved_controls = 0, reserved_invites = 28 WHERE user_id = ? AND relay_host_id = ?`,
      [IDENTITY.userId, IDENTITY.relayHostId]
    )
    const cellReserved = async () =>
      Number((await database.query(`SELECT reserved_requests FROM relay_cells WHERE cell_id = ?`, [GCE_CELL.id]))[0]!.reserved_requests)
    const row = async () =>
      (await database.query(
        `SELECT cell_id, reserved_controls, reserved_invites FROM relay_assignments WHERE user_id = ? AND relay_host_id = ?`,
        [IDENTITY.userId, IDENTITY.relayHostId]
      ))[0]!
    const logged = (event: string) =>
      warn.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.startsWith('{'))
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((line) => line.event === event)
    return { database, edge, pushes, placed, cellReserved, row, logged }
  }

  it('moves the host, zeroes the counters and leaves the old cell counter alone', async () => {
    const h = await setup()
    const reservedBefore = await h.cellReserved()
    const moved = await h.edge.moveToEdge(IDENTITY, 0, undefined, undefined, { ownControl: true, staleOnReserveCells: RESERVE })
    expect(moved.cellId).toBe(EDGE_CELL_ID)
    const after = await h.row()
    expect(after.cell_id).toBe(EDGE_CELL_ID)
    expect(Number(after.reserved_invites)).toBe(0)
    expect(Number(after.reserved_controls)).toBe(0)
    expect(await h.cellReserved()).toBe(reservedBefore)
    expect(h.pushes).toHaveLength(1)
    expect(h.logged('orca_relay_edge_moved')).toEqual([
      expect.objectContaining({ fromCellId: GCE_CELL.id, staleUnits: true })
    ])
  })

  it('defers when a lease backs any unit', async () => {
    const h = await setup()
    await h.database.query(
      `INSERT INTO relay_assignment_activity_leases
       (user_id, relay_host_id, activity_id, activity_kind, cell_id, request_units, expires_at, updated_at)
       VALUES (?, ?, 'invite:c7:1', 'invite', ?, 1, 99999999999999, 0)`,
      [IDENTITY.userId, IDENTITY.relayHostId, GCE_CELL.id]
    )
    const deferred = await h.edge
      .moveToEdge(IDENTITY, 0, undefined, undefined, { ownControl: true, staleOnReserveCells: RESERVE })
      .catch((error: unknown) => error)
    expect(deferred).toBeInstanceOf(EdgeMoveDeferredError)
    expect(deferred).toMatchObject({ reason: 'units_held' })
    expect((await h.row()).cell_id).toBe(GCE_CELL.id)
    expect(h.pushes).toHaveLength(0)
  })

  it('moves the host past leases that have all expired', async () => {
    const h = await setup()
    await h.database.query(
      `INSERT INTO relay_assignment_activity_leases
       (user_id, relay_host_id, activity_id, activity_kind, cell_id, request_units, expires_at, updated_at)
       VALUES (?, ?, 'invite:c7:1', 'invite', ?, 1, 900, 0), (?, ?, 'invite:c7:2', 'invite', ?, 1, 1000, 0)`,
      [IDENTITY.userId, IDENTITY.relayHostId, GCE_CELL.id, IDENTITY.userId, IDENTITY.relayHostId, GCE_CELL.id]
    )
    const moved = await h.edge.moveToEdge(IDENTITY, 0, undefined, undefined, { ownControl: true, staleOnReserveCells: RESERVE })
    expect(moved.cellId).toBe(EDGE_CELL_ID)
    expect(Number((await h.row()).reserved_invites)).toBe(0)
    expect(h.logged('orca_relay_edge_moved')).toEqual([expect.objectContaining({ staleUnits: true })])
  })

  it('defers when one lease is live beside expired ones', async () => {
    const h = await setup()
    await h.database.query(
      `INSERT INTO relay_assignment_activity_leases
       (user_id, relay_host_id, activity_id, activity_kind, cell_id, request_units, expires_at, updated_at)
       VALUES (?, ?, 'invite:c7:1', 'invite', ?, 1, 900, 0), (?, ?, 'invite:c7:2', 'invite', ?, 1, 1001, 0)`,
      [IDENTITY.userId, IDENTITY.relayHostId, GCE_CELL.id, IDENTITY.userId, IDENTITY.relayHostId, GCE_CELL.id]
    )
    const deferred = await h.edge
      .moveToEdge(IDENTITY, 0, undefined, undefined, { ownControl: true, staleOnReserveCells: RESERVE })
      .catch((error: unknown) => error)
    expect(deferred).toMatchObject({
      reason: 'units_held',
      stale: { candidate: true, leases: 2, liveLeases: 1, liveKinds: ['invite'], otherCellLeases: 0 }
    })
    expect((await h.row()).cell_id).toBe(GCE_CELL.id)
    expect(h.pushes).toHaveLength(0)
  })

  it('defers when the cell is not in reserve mode, or without the option', async () => {
    const h = await setup()
    for (const options of [{ ownControl: true, staleOnReserveCells: new Set<string>() }, { ownControl: true }]) {
      const deferred = await h.edge.moveToEdge(IDENTITY, 0, undefined, undefined, options).catch((error: unknown) => error)
      expect(deferred).toMatchObject({
        reason: 'units_held',
        held: expect.objectContaining({ invites: 28 }),
        stale: { candidate: false }
      })
    }
    expect((await h.row()).cell_id).toBe(GCE_CELL.id)
    expect(h.pushes).toHaveLength(0)
  })
})

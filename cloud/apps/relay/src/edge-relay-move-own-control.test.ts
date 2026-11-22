import { afterEach, describe, expect, it, vi } from 'vitest'
import { RelayAssignmentStore } from './assignment/assignment-store.js'
import type { RelayCellConfig } from './config.js'
import { openInMemoryRelayDatabase, type RelayDatabase } from './database.js'
import type { EdgeAdmin, EdgeAssignBody } from './edge-admin-client.js'
import { edgeMoveOwnControlAsk, parseEdgeControl, parseEdgeControlOver, type EdgeControlFlags } from './edge-relay-control.js'
import { EDGE_CELL_ID, EdgeAssignments, EdgeMoveDeferredError, type EdgeRelayConfig } from './edge-relay.js'

const EDGE_URL = 'https://edge.relay.example.com'
const DOOR = 'https://door.relay.example.com'
const GCE_CELL: RelayCellConfig = { id: 'production-gce-c3', url: 'https://c3.relay.example.com', capacityRequests: 1_000 }
const IDENTITY = { userId: 'user-1', relayHostId: 'abcdefghijklmnop' }
const INCARNATION = '11111111-1111-4111-8111-111111111111'
const COUNTERS = [
  'reserved_controls',
  'reserved_splices',
  'reserved_invites',
  'pending_installs',
  'pending_confirmations',
  'migration_leases'
] as const

describe('moveOwnControl flag', () => {
  it('parses off and drain; a bad value drops only that key and keeps the last applied', () => {
    for (const moveOwnControl of ['off', 'drain'] as const) {
      expect(parseEdgeControl({ v: 1, flags: { mode: 'on', moveOwnControl } })).toEqual({
        flags: { mode: 'on', moveOwnControl },
        ignoredKeys: []
      })
    }
    const previous: EdgeControlFlags = { mode: 'on', moveOwnControl: 'drain' }
    for (const moveOwnControl of ['on', 'reconnect', true, 1, null, { drain: true }]) {
      expect(parseEdgeControlOver({ v: 1, flags: { mode: 'off', rolloutPermille: 3, moveOwnControl } }, previous)).toEqual({
        flags: { mode: 'off', rolloutPermille: 3, moveOwnControl: 'drain' },
        ignoredKeys: ['moveOwnControl']
      })
    }
    // Nothing applied before: a bad value is just absent.
    expect(parseEdgeControl({ v: 1, flags: { moveOwnControl: 'yes' } })).toEqual({
      flags: { mode: 'on' },
      ignoredKeys: ['moveOwnControl']
    })
    // Absent from a later write: off again.
    expect(parseEdgeControlOver({ v: 1, flags: {} }, previous)).toEqual({ flags: { mode: 'on' }, ignoredKeys: [] })
  })

  it('qualifies asks: off never, drain only a reconnect without regionCorrection', () => {
    const drainAsk = { reconnect: true }
    const refreshAsk = { reconnect: true, regionCorrection: { v: 1, action: 'issue-window' } }
    const freshAsk = {}
    const qualifies = (moveOwnControl: EdgeControlFlags['moveOwnControl']) =>
      [drainAsk, refreshAsk, freshAsk].map((ask) =>
        edgeMoveOwnControlAsk({ mode: 'on', ...(moveOwnControl ? { moveOwnControl } : {}) }, ask)
      )
    expect(qualifies(undefined)).toEqual([false, false, false])
    expect(qualifies('off')).toEqual([false, false, false])
    expect(qualifies('drain')).toEqual([true, false, false])
  })
})

describe('edge move past the host\'s own control', () => {
  const databases: RelayDatabase[] = []
  afterEach(async () => {
    vi.restoreAllMocks()
    for (const database of databases.splice(0)) { await database.close() }
  })

  async function setup(edgeOverrides: Partial<EdgeRelayConfig> = {}) {
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
      {
        cellUrl: EDGE_URL,
        rolloutPercent: 0,
        allowHosts: new Set(),
        denyHosts: new Set(),
        regions: new Set(['us-central1']),
        ...edgeOverrides
      },
      () => now,
      admin
    )
    await edge.ensureEdgeCell()
    // Numbers as numbers on either dialect (PostgreSQL answers BIGINT as strings).
    const row = async () => {
      const found = (await database.query(`SELECT * FROM relay_assignments WHERE user_id = ? AND relay_host_id = ?`, [
        IDENTITY.userId,
        IDENTITY.relayHostId
      ]))[0]!
      return Object.fromEntries(
        Object.entries(found).map(([key, value]) => [key, key === 'cell_id' || key === 'user_id' || key === 'relay_host_id' ? value : Number(value)])
      )
    }
    const leases = async () =>
      await database.query(`SELECT activity_id, cell_id FROM relay_assignment_activity_leases WHERE relay_host_id = ?`, [
        IDENTITY.relayHostId
      ])
    const cellReserved = async () =>
      Number(
        (await database.query(`SELECT reserved_requests FROM relay_cells WHERE cell_id = ?`, [GCE_CELL.id]))[0]!
          .reserved_requests
      )
    const counters = async () => {
      const current = await row()
      return Object.fromEntries(COUNTERS.map((column) => [column, Number(current[column])]))
    }
    const logged = (event: string) =>
      warn.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.startsWith('{'))
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((line) => line.event === event)
    return { database, store, edge, pushes, row, leases, cellReserved, counters, logged }
  }

  // The host on its GCE cell with its control up there: the director's placement (a pending
  // control lease and one control unit), then the cell's activation of the control.
  async function connectedOnGce(h: Awaited<ReturnType<typeof setup>>) {
    const placed = await h.store.assign(IDENTITY)
    expect(placed.cellId).toBe(GCE_CELL.id)
    const activityId = await h.store.activateControl(IDENTITY, {
      cellId: GCE_CELL.id,
      assignmentEpoch: placed.assignmentEpoch,
      generation: 1,
      cellIncarnation: INCARNATION
    })
    expect(await h.counters()).toMatchObject({ reserved_controls: 1, reserved_splices: 0 })
    expect(await h.leases()).toEqual([{ activity_id: activityId, cell_id: GCE_CELL.id }])
    expect(await h.cellReserved()).toBe(1)
    return { placed, activityId }
  }

  it('defers on the host\'s own control without the option, counting it as own-control-only', async () => {
    const h = await setup()
    const { placed } = await connectedOnGce(h)
    const deferred = await h.edge.moveToEdge(IDENTITY, 0).catch((error: unknown) => error)
    expect(deferred).toBeInstanceOf(EdgeMoveDeferredError)
    expect(deferred).toMatchObject({
      reason: 'units_held',
      ownControlOnly: true,
      held: { controls: 1, splices: 0, invites: 0, installs: 0, confirmations: 0, migrationLeases: 0 }
    })
    expect(await h.row()).toMatchObject({ cell_id: GCE_CELL.id, assignment_epoch: placed.assignmentEpoch })
    expect(await h.cellReserved()).toBe(1)
    expect(h.pushes).toEqual([])
  })

  it('moves with the option: newer epoch, an edge row with no units and no lease, the old cell\'s unit released', async () => {
    const h = await setup()
    const { placed, activityId } = await connectedOnGce(h)
    // A claimed connection reservation at the old epoch, and one at another epoch the move must keep.
    for (const [id, epoch] of [['res-old', placed.assignmentEpoch], ['res-other', placed.assignmentEpoch + 7]] as const) {
      await h.database.query(
        `INSERT INTO relay_control_connection_reservations
         (reservation_id, idempotency_key, user_id, relay_host_id, assignment_epoch, cell_id, state, created_at, timeout_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'claimed', 1000, 99999999, 1000)`,
        [id, `key-${id}`, IDENTITY.userId, IDENTITY.relayHostId, epoch, GCE_CELL.id]
      )
    }
    const capabilities = async () =>
      await h.database.query(`SELECT activity_id FROM relay_control_capabilities WHERE relay_host_id = ?`, [IDENTITY.relayHostId])
    expect(await capabilities()).toEqual([{ activity_id: activityId }])
    const moved = await h.edge.moveToEdge(IDENTITY, 0, 'us-central1', undefined, { ownControl: true })
    expect(moved).toMatchObject({ cellId: EDGE_CELL_ID, cellUrl: EDGE_URL, assignmentEpoch: placed.assignmentEpoch + 1 })
    expect(await h.row()).toMatchObject({ cell_id: EDGE_CELL_ID, assignment_epoch: placed.assignmentEpoch + 1 })
    expect(await h.counters()).toEqual(Object.fromEntries(COUNTERS.map((column) => [column, 0])))
    expect(await h.leases()).toEqual([])
    expect(await h.cellReserved()).toBe(0)
    expect(
      await h.database.query(
        `SELECT reservation_id, state FROM relay_control_connection_reservations WHERE relay_host_id = ? ORDER BY reservation_id`,
        [IDENTITY.relayHostId]
      )
    ).toEqual([
      { reservation_id: 'res-old', state: 'released' },
      { reservation_id: 'res-other', state: 'claimed' }
    ])
    expect(await capabilities()).toEqual([])
    expect(h.pushes).toHaveLength(1)
    expect(h.logged('orca_relay_edge_moved')).toEqual([
      { event: 'orca_relay_edge_moved', fromCellId: GCE_CELL.id, assignmentEpoch: placed.assignmentEpoch + 1, ownControl: true }
    ])

    // The old cell, late: its release finds nothing, its renewal and a re-activation see the row
    // elsewhere (the cell closes that control), and none of it touches the edge row or the cell.
    expect(await h.store.releaseActivity(IDENTITY, activityId)).toBe(false)
    await expect(
      h.store.renewControlActivity(IDENTITY, { activityId, cellId: GCE_CELL.id, expiresAt: 2_000 })
    ).rejects.toThrow('activity_cell_not_authoritative')
    await expect(
      h.store.activateControl(IDENTITY, {
        cellId: GCE_CELL.id,
        assignmentEpoch: placed.assignmentEpoch,
        generation: 2,
        cellIncarnation: INCARNATION
      })
    ).rejects.toThrow('wrong_assignment')
    await expect(
      h.store.acquireActivity(IDENTITY, { activityId: 'splice:late', kind: 'splice', cellId: GCE_CELL.id })
    ).rejects.toThrow('activity_cell_not_authoritative')
    expect(await h.row()).toMatchObject({ cell_id: EDGE_CELL_ID, assignment_epoch: placed.assignmentEpoch + 1 })
    expect(await h.counters()).toEqual(Object.fromEntries(COUNTERS.map((column) => [column, 0])))
    expect(await h.cellReserved()).toBe(0)
    // The expiry sweeps find nothing of this host either.
    await h.store.releaseExpiredActivityLeases()
    await h.store.releaseExpiredActivity()
    expect(await h.cellReserved()).toBe(0)
  })

  it('moves a host whose unit is the director\'s pending control (answered, not yet connected)', async () => {
    const h = await setup()
    const placed = await h.store.assign(IDENTITY)
    expect(await h.leases()).toEqual([{ activity_id: `control-pending:${placed.assignmentEpoch}`, cell_id: GCE_CELL.id }])
    const moved = await h.edge.moveToEdge(IDENTITY, 0, undefined, undefined, { ownControl: true })
    expect(moved.assignmentEpoch).toBe(placed.assignmentEpoch + 1)
    expect(await h.leases()).toEqual([])
    expect(await h.cellReserved()).toBe(0)
  })

  it('takes the same path through front doors', async () => {
    const h = await setup({ frontDoorUrls: new Set([DOOR]), control: () => ({ mode: 'on' }) })
    const { placed } = await connectedOnGce(h)
    await expect(h.edge.moveToEdge(IDENTITY, 0, 'us-central1', { switchable: true })).rejects.toMatchObject({
      reason: 'units_held',
      ownControlOnly: true
    })
    const moved = await h.edge.moveToEdge(IDENTITY, 0, 'us-central1', { frontDoor: DOOR, switchable: true }, { ownControl: true })
    expect(moved).toMatchObject({ cellUrl: DOOR, assignmentEpoch: placed.assignmentEpoch + 1 })
    expect(await h.counters()).toEqual(Object.fromEntries(COUNTERS.map((column) => [column, 0])))
    expect(await h.leases()).toEqual([])
    expect(await h.cellReserved()).toBe(0)
  })

  for (const column of COUNTERS.filter((name) => name !== 'reserved_controls')) {
    it(`still defers with the option while the host holds ${column}`, async () => {
      const h = await setup()
      const { placed } = await connectedOnGce(h)
      await h.database.query(`UPDATE relay_assignments SET ${column} = 1 WHERE relay_host_id = ?`, [IDENTITY.relayHostId])
      await expect(h.edge.moveToEdge(IDENTITY, 0, undefined, undefined, { ownControl: true })).rejects.toMatchObject({
        reason: 'units_held',
        ownControlOnly: false
      })
      expect(await h.row()).toMatchObject({ cell_id: GCE_CELL.id, assignment_epoch: placed.assignmentEpoch })
      expect(await h.leases()).toHaveLength(1)
      expect(await h.cellReserved()).toBe(1)
    })
  }

  it('still defers with the option for two controls, a unit no lease backs, another lease, or an open migration or rehome', async () => {
    const cases: [string, (h: Awaited<ReturnType<typeof setup>>, epoch: number) => Promise<void>][] = [
      ['two control units', async (h) => {
        await h.database.query(`UPDATE relay_assignments SET reserved_controls = 2 WHERE relay_host_id = ?`, [IDENTITY.relayHostId])
      }],
      ['an unbacked unit', async (h) => {
        await h.database.query(`DELETE FROM relay_assignment_activity_leases WHERE relay_host_id = ?`, [IDENTITY.relayHostId])
      }],
      ['a second lease', async (h) => {
        await h.database.query(
          `INSERT INTO relay_assignment_activity_leases
           (user_id, relay_host_id, activity_id, activity_kind, cell_id, request_units, expires_at, updated_at)
           VALUES (?, ?, 'invite:x', 'invite', ?, 1, 99999999, 1000)`,
          [IDENTITY.userId, IDENTITY.relayHostId, GCE_CELL.id]
        )
      }],
      ['its one lease is an invite, not a control', async (h) => {
        await h.database.query(`UPDATE relay_assignment_activity_leases SET activity_kind = 'invite' WHERE relay_host_id = ?`, [
          IDENTITY.relayHostId
        ])
      }],
      ['its one control lease holds two units', async (h) => {
        await h.database.query(`UPDATE relay_assignment_activity_leases SET request_units = 2 WHERE relay_host_id = ?`, [
          IDENTITY.relayHostId
        ])
      }],
      ['a lease on another cell', async (h) => {
        await h.database.query(`UPDATE relay_assignment_activity_leases SET cell_id = 'other-cell' WHERE relay_host_id = ?`, [
          IDENTITY.relayHostId
        ])
      }],
      ['an open migration', async (h, epoch) => {
        await h.database.query(
          `INSERT INTO relay_assignment_migrations
           (user_id, relay_host_id, source_cell_id, target_cell_id, previous_epoch, assignment_epoch,
            source_request_units, target_reserved_units, expires_at, created_at, updated_at)
           VALUES (?, ?, 'other-cell', ?, ?, ?, 1, 1, 99999999, 1000, 1000)`,
          [IDENTITY.userId, IDENTITY.relayHostId, GCE_CELL.id, epoch - 1, epoch]
        )
      }],
      ['an open rehome', async (h, epoch) => {
        await h.database.query(
          `INSERT INTO relay_region_rehome_attempts
           (attempt_id, user_id, relay_host_id, preferred_region, source_cell_id, source_cell_incarnation,
            target_cell_id, target_cell_incarnation, previous_epoch, assignment_epoch, drain_grace_ms,
            send_attempts, created_at, updated_at)
           VALUES ('attempt-1', ?, ?, 'us-central1', ?, ?, 'other-cell', ?, ?, ?, 1000, 0, 1000, 1000)`,
          [IDENTITY.userId, IDENTITY.relayHostId, GCE_CELL.id, INCARNATION, INCARNATION, epoch - 1, epoch]
        )
      }]
    ]
    for (const [name, arrange] of cases) {
      const h = await setup()
      const { placed } = await connectedOnGce(h)
      await arrange(h, placed.assignmentEpoch)
      const before = { row: await h.row(), leases: await h.leases(), cell: await h.cellReserved() }
      const outcome = await h.edge.moveToEdge(IDENTITY, 0, undefined, undefined, { ownControl: true }).catch((error: unknown) => error)
      expect(outcome, name).toBeInstanceOf(EdgeMoveDeferredError)
      expect(await h.row(), name).toEqual(before.row)
      expect(await h.leases(), name).toEqual(before.leases)
      expect(await h.cellReserved(), name).toBe(before.cell)
      expect(h.pushes, name).toEqual([])
    }
  })

  it('a failed push rolls the whole move back, the old cell\'s unit and lease included', async () => {
    const h = await setup()
    const { placed, activityId } = await connectedOnGce(h)
    const failing = new EdgeAssignments(
      h.database,
      { cellUrl: EDGE_URL, rolloutPercent: 0, allowHosts: new Set(), denyHosts: new Set(), regions: new Set(['us-central1']) },
      () => 1_000,
      {
        assign: async () => {
          const { EdgeAdminUnavailableError } = await import('./edge-admin-client.js')
          throw new EdgeAdminUnavailableError('status_503')
        }
      } as unknown as EdgeAdmin
    )
    await failing.ensureEdgeCell()
    await expect(failing.moveToEdge(IDENTITY, 0, undefined, undefined, { ownControl: true })).rejects.toMatchObject({
      reason: 'push_failed'
    })
    expect(await h.row()).toMatchObject({ cell_id: GCE_CELL.id, assignment_epoch: placed.assignmentEpoch, reserved_controls: 1 })
    expect(await h.leases()).toEqual([{ activity_id: activityId, cell_id: GCE_CELL.id }])
    expect(await h.cellReserved()).toBe(1)
  })
})

import { ASSIGNMENT_LIMITS } from '@orca-cloud/relay-contract'
import { afterEach, describe, expect, it } from 'vitest'
import { RelayAssignmentStore } from './assignment-store.js'
import type { RelayCellConfig } from './config.js'
import {
  openInMemoryRelayDatabase,
  type RelayDatabase
} from './database.js'

const LIMITED_CELL: RelayCellConfig = {
  id: 'limited',
  url: 'https://limited.example.com',
  capacityRequests: 1_000,
  connectionHardCap: 600,
  connectionUnobservedBound: 50
}

const databases: RelayDatabase[] = []

afterEach(async () => {
  for (const database of databases.splice(0)) await database.close()
})

async function setup(
  connectionUnits: number,
  now: () => number = () => 100
): Promise<{ database: RelayDatabase; store: RelayAssignmentStore }> {
  const database = await openInMemoryRelayDatabase()
  databases.push(database)
  const store = new RelayAssignmentStore(database, now, {
    requireLiveCells: true,
    heartbeatTtlMs: 45_000
  })
  await store.reconcileCells([LIMITED_CELL], true)
  await store.recordCellHeartbeat({
    cellId: LIMITED_CELL.id,
    cellUrl: LIMITED_CELL.url,
    cellIncarnation: '11111111-1111-4111-8111-111111111111',
    startedAt: 50,
    ready: true,
    observedRequests: 0,
    totalConnections: connectionUnits,
    inFlightConnections: 0,
    reservedConnectionUnits: 0,
    enforcedConnectionUnits: connectionUnits,
    connectionHardCap: 600,
    connectionUnobservedBound: 50
  })
  return { database, store }
}

async function setupHeadroomReassignment(): Promise<{
  database: RelayDatabase
  store: RelayAssignmentStore
  source: RelayCellConfig
  target: RelayCellConfig
}> {
  const database = await openInMemoryRelayDatabase()
  databases.push(database)
  const store = new RelayAssignmentStore(database, () => 100, {
    requireLiveCells: true,
    heartbeatTtlMs: 45_000
  })
  const source = {
    ...LIMITED_CELL,
    id: 'saturated-source',
    url: 'https://saturated-source.example.com'
  }
  const target = {
    ...LIMITED_CELL,
    id: 'available-target',
    url: 'https://available-target.example.com'
  }
  await store.reconcileCells([source, target], true)
  await store.recordCellHeartbeat({
    cellId: source.id,
    cellUrl: source.url,
    cellIncarnation: '11111111-1111-4111-8111-111111111111',
    startedAt: 50,
    ready: true,
    observedRequests: 0,
    totalConnections: 450,
    inFlightConnections: 0,
    reservedConnectionUnits: 0,
    enforcedConnectionUnits: 450,
    connectionHardCap: 600,
    connectionUnobservedBound: 50
  })
  await store.recordCellHeartbeat({
    cellId: target.id,
    cellUrl: target.url,
    cellIncarnation: '22222222-2222-4222-8222-222222222222',
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
  return { database, store, source, target }
}

describe('relay assignment connection headroom', () => {
  it('requires exact, internally consistent telemetry from limited cells', async () => {
    const database = await openInMemoryRelayDatabase()
    databases.push(database)
    const store = new RelayAssignmentStore(database, () => 100)
    await store.reconcileCells([LIMITED_CELL], true)
    const heartbeat = {
      cellId: LIMITED_CELL.id,
      cellUrl: LIMITED_CELL.url,
      cellIncarnation: '11111111-1111-4111-8111-111111111111',
      startedAt: 50,
      ready: true,
      observedRequests: 0
    }

    await expect(store.recordCellHeartbeat(heartbeat)).rejects.toThrow(
      'cell_connection_telemetry_mismatch'
    )
    await expect(
      store.recordCellHeartbeat({
        ...heartbeat,
        totalConnections: 550,
        inFlightConnections: 2,
        reservedConnectionUnits: 3,
        enforcedConnectionUnits: 554,
        connectionHardCap: 600,
        connectionUnobservedBound: 50
      })
    ).rejects.toThrow('cell_connection_telemetry_mismatch')
    await expect(
      store.recordCellHeartbeat({
        ...heartbeat,
        totalConnections: 601,
        inFlightConnections: 0,
        reservedConnectionUnits: 0,
        enforcedConnectionUnits: 601,
        connectionHardCap: 600,
        connectionUnobservedBound: 50
      })
    ).resolves.toBeUndefined()
  })

  it('reports the limited-cell capacity contract and telemetry components', async () => {
    const { store } = await setup(0)
    await store.recordCellHeartbeat({
      cellId: LIMITED_CELL.id,
      cellUrl: LIMITED_CELL.url,
      cellIncarnation: '11111111-1111-4111-8111-111111111111',
      startedAt: 50,
      ready: true,
      observedRequests: 0,
      totalConnections: 120,
      inFlightConnections: 2,
      reservedConnectionUnits: 3,
      enforcedConnectionUnits: 125,
      connectionHardCap: 600,
      connectionUnobservedBound: 50
    })

    expect((await store.cellDeploymentStatus(LIMITED_CELL.id)).connectionCapacity).toEqual({
      hardCap: 600,
      controlRebindReserve: 100,
      ordinaryConnectionLimit: 500,
      unobservedBound: 50,
      normalAdmissionPause: 450,
      observedConnections: 120,
      inFlightConnections: 2,
      reservedConnectionUnits: 3,
      enforcedConnectionUnits: 125,
      pendingControlReservations: 0,
      heartbeatFresh: true
    })
  })

  it('fails placement closed while a cell changes connection limits', async () => {
    const { store } = await setup(449)
    const expanded = {
      ...LIMITED_CELL,
      connectionHardCap: 1_000 as const
    }

    await store.reconcileCells([expanded], true)
    await expect(
      store.assign({ userId: 'transition-user', relayHostId: 'host000000000099' })
    ).rejects.toThrow('relay_capacity_exhausted')
    await expect(store.cellDeploymentStatus(expanded.id)).resolves.toMatchObject({
      connectionCapacity: { hardCap: 1_000, heartbeatFresh: false }
    })

    await store.recordCellHeartbeat({
      cellId: expanded.id,
      cellUrl: expanded.url,
      cellIncarnation: '22222222-2222-4222-8222-222222222222',
      startedAt: 200,
      ready: true,
      observedRequests: 0,
      totalConnections: 449,
      inFlightConnections: 0,
      reservedConnectionUnits: 0,
      enforcedConnectionUnits: 449,
      connectionHardCap: 1_000,
      connectionUnobservedBound: 50
    })
    await expect(store.cellDeploymentStatus(expanded.id)).resolves.toMatchObject({
      connectionCapacity: {
        hardCap: 1_000,
        ordinaryConnectionLimit: 900,
        normalAdmissionPause: 850,
        heartbeatFresh: true
      }
    })
  })

  it('fails placement closed while the admin path changes connection limits', async () => {
    const { store } = await setup(449)
    const expanded = {
      ...LIMITED_CELL,
      connectionHardCap: 1_000 as const
    }

    await store.configureCell(expanded, 'general')
    await expect(
      store.assign({ userId: 'admin-transition', relayHostId: 'host000000000098' })
    ).rejects.toThrow('relay_capacity_exhausted')
    await expect(store.cellDeploymentStatus(expanded.id)).resolves.toMatchObject({
      connectionCapacity: { hardCap: 1_000, heartbeatFresh: false }
    })

    await store.recordCellHeartbeat({
      cellId: expanded.id,
      cellUrl: expanded.url,
      cellIncarnation: '22222222-2222-4222-8222-222222222222',
      startedAt: 200,
      ready: true,
      observedRequests: 0,
      totalConnections: 449,
      inFlightConnections: 0,
      reservedConnectionUnits: 0,
      enforcedConnectionUnits: 449,
      connectionHardCap: 1_000,
      connectionUnobservedBound: 50
    })
    await expect(
      store.assign({ userId: 'admin-restored', relayHostId: 'host000000000097' })
    ).resolves.toMatchObject({ cellId: expanded.id })
  })

  it('admits exactly one reservation at the admission boundary', async () => {
    const { database, store } = await setup(449)
    const results = await Promise.allSettled([
      store.assign({ userId: 'user-1', relayHostId: 'host000000000001' }),
      store.assign({ userId: 'user-2', relayHostId: 'host000000000002' })
    ])

    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
    expect(
      results.filter(({ status }) => status === 'rejected').map((result) =>
        result.status === 'rejected' ? result.reason : null
      )
    ).toEqual([expect.objectContaining({ message: 'relay_capacity_exhausted' })])
    expect(
      await database.query(
        `SELECT activity_id FROM relay_assignment_activity_leases
         WHERE activity_kind = 'control' AND activity_id LIKE 'control-pending:%'`
      )
    ).toHaveLength(1)
  })

  it('rejects at the boundary before mutating durable assignment state', async () => {
    const { database, store } = await setup(450)

    await expect(
      store.assign({ userId: 'user-1', relayHostId: 'host000000000001' })
    ).rejects.toThrow('relay_capacity_exhausted')
    expect(await database.query(`SELECT * FROM relay_assignments`)).toEqual([])
    expect(await database.query(`SELECT * FROM relay_assignment_activity_leases`)).toEqual([])
  })

  it('charges every active reservation state at the admission boundary', async () => {
    const { database, store } = await setup(447)
    await database.query(
      `INSERT INTO relay_control_connection_reservations
       (reservation_id, idempotency_key, user_id, relay_host_id,
        assignment_epoch, cell_id, state, created_at, timeout_at, updated_at)
       VALUES
         ('active-reserved', 'active-reserved', 'state-user', 'state-host-1',
          1, ?, 'reserved', 1, 2, 1),
         ('active-debt', 'active-debt', 'state-user', 'state-host-2',
          1, ?, 'late-arrival-debt', 1, 2, 1),
         ('active-claimed', 'active-claimed', 'state-user', 'state-host-3',
          1, ?, 'claimed', 1, 2, 1)`,
      [LIMITED_CELL.id, LIMITED_CELL.id, LIMITED_CELL.id]
    )

    await expect(
      store.assign({ userId: 'blocked-user', relayHostId: 'blockedhost00001' })
    ).rejects.toThrow('relay_capacity_exhausted')
    expect(await database.query(`SELECT * FROM relay_assignment_activity_leases`)).toEqual([])
  })

  it('does not charge released reservation history', async () => {
    const { database, store } = await setup(449)
    await database.query(
      `INSERT INTO relay_control_connection_reservations
       (reservation_id, idempotency_key, user_id, relay_host_id,
        assignment_epoch, cell_id, state, created_at, timeout_at, updated_at)
       VALUES ('released-history', 'released-history', 'state-user', 'state-host',
               1, ?, 'released', 1, 2, 1)`,
      [LIMITED_CELL.id]
    )

    await expect(
      store.assign({ userId: 'admitted-user', relayHostId: 'admittedhost0001' })
    ).resolves.toMatchObject({ cellId: LIMITED_CELL.id })
  })

  it('rejects sticky control restoration before mutating assignment state', async () => {
    const { database, store } = await setup(450)
    const identity = { userId: 'sticky-user', relayHostId: 'stickyhost000001' }
    await database.query(
      `INSERT INTO relay_assignments
       (user_id, relay_host_id, cell_id, assignment_epoch, lease_expires_at,
        last_activity_at, reserved_controls, reserved_splices, reserved_invites,
        pending_installs, pending_confirmations, migration_leases)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        identity.userId,
        identity.relayHostId,
        LIMITED_CELL.id,
        1,
        10_000,
        100,
        0,
        0,
        1,
        0,
        0,
        0
      ]
    )

    await expect(store.assign(identity)).rejects.toThrow(
      'relay_connection_headroom_exhausted'
    )
    expect(
      await database.query(
        `SELECT cell_id, assignment_epoch, reserved_controls, reserved_invites
         FROM relay_assignments WHERE user_id = ? AND relay_host_id = ?`,
        [identity.userId, identity.relayHostId]
      )
    ).toEqual([
      {
        cell_id: LIMITED_CELL.id,
        assignment_epoch: 1,
        reserved_controls: 0,
        reserved_invites: 1
      }
    ])
    expect(await database.query(`SELECT * FROM relay_assignment_activity_leases`)).toEqual([])
  })

  it('moves a zero-activity assignment off a general cell without connection headroom', async () => {
    const { database, store, source, target } = await setupHeadroomReassignment()
    const identity = { userId: 'movable-user', relayHostId: 'movablehost000001' }
    await database.query(
      `INSERT INTO relay_assignments
       (user_id, relay_host_id, cell_id, assignment_epoch, lease_expires_at,
        last_activity_at, reserved_controls, reserved_splices, reserved_invites,
        pending_installs, pending_confirmations, migration_leases)
       VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 0, 0)`,
      [identity.userId, identity.relayHostId, source.id, 7, 10_000, 100]
    )
    await database.query(
      `INSERT INTO relay_control_connection_reservations
       (reservation_id, idempotency_key, user_id, relay_host_id,
        assignment_epoch, cell_id, state, inclusion_watermark,
        claim_activity_id, created_at, timeout_at, claimed_at, released_at,
        updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'late-arrival-debt', NULL, NULL, ?, ?, NULL, NULL, ?)`,
      [
        'superseded-reservation',
        'superseded-reservation',
        identity.userId,
        identity.relayHostId,
        7,
        source.id,
        50,
        99,
        100
      ]
    )

    await expect(store.assign(identity)).resolves.toMatchObject({
      cellId: target.id,
      assignmentEpoch: 8
    })
    expect(
      await database.query(
        `SELECT cell_id, assignment_epoch, reserved_controls
         FROM relay_assignments WHERE user_id = ? AND relay_host_id = ?`,
        [identity.userId, identity.relayHostId]
      )
    ).toEqual([{ cell_id: target.id, assignment_epoch: 8, reserved_controls: 1 }])
    expect(
      await database.query(
        `SELECT cell_id, activity_kind FROM relay_assignment_activity_leases
         WHERE user_id = ? AND relay_host_id = ?`,
        [identity.userId, identity.relayHostId]
      )
    ).toEqual([{ cell_id: target.id, activity_kind: 'control' }])
    expect(
      await database.query(
        `SELECT cell_id, assignment_epoch, state
         FROM relay_control_connection_reservations
         WHERE user_id = ? AND relay_host_id = ?
         ORDER BY assignment_epoch`,
        [identity.userId, identity.relayHostId]
      )
    ).toEqual([
      { cell_id: source.id, assignment_epoch: 7, state: 'released' },
      { cell_id: target.id, assignment_epoch: 8, state: 'reserved' }
    ])
  })

  it('keeps non-control activity pinned when its cell has no connection headroom', async () => {
    const { database, store, source } = await setupHeadroomReassignment()
    const identity = { userId: 'pinned-user', relayHostId: 'pinnedhost0000001' }
    await database.query(
      `INSERT INTO relay_assignments
       (user_id, relay_host_id, cell_id, assignment_epoch, lease_expires_at,
        last_activity_at, reserved_controls, reserved_splices, reserved_invites,
        pending_installs, pending_confirmations, migration_leases)
       VALUES (?, ?, ?, ?, ?, ?, 0, 0, 1, 0, 0, 0)`,
      [identity.userId, identity.relayHostId, source.id, 7, 10_000, 100]
    )

    await expect(store.assign(identity)).rejects.toThrow(
      'relay_connection_headroom_exhausted'
    )
    expect(await store.resolve(identity)).toMatchObject({
      cellId: source.id,
      assignmentEpoch: 7
    })
  })

  it.each(['existing-only', 'migration-only'] as const)(
    'keeps a zero-activity assignment pinned on a %s cell without connection headroom',
    async (admission) => {
      const { database, store, source } = await setupHeadroomReassignment()
      const identity = {
        userId: `pinned-${admission}-user`,
        relayHostId: `pinned${admission.replace('-', '')}`
      }
      await store.setCellAdmissionState(source.id, admission)
      await database.query(
        `INSERT INTO relay_assignments
         (user_id, relay_host_id, cell_id, assignment_epoch, lease_expires_at,
          last_activity_at, reserved_controls, reserved_splices, reserved_invites,
          pending_installs, pending_confirmations, migration_leases)
         VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 0, 0)`,
        [identity.userId, identity.relayHostId, source.id, 7, 10_000, 100]
      )

      await expect(store.assign(identity)).rejects.toThrow(
        'relay_connection_headroom_exhausted'
      )
      expect(await store.resolve(identity)).toMatchObject({
        cellId: source.id,
        assignmentEpoch: 7
      })
      expect(await database.query(`SELECT * FROM relay_assignment_activity_leases`)).toEqual([])
    }
  )

  it('renames a pending reservation exactly once on control activation', async () => {
    const { database, store } = await setup(449)
    const identity = { userId: 'user-1', relayHostId: 'host000000000001' }
    const assignment = await store.assign(identity)

    await store.activateControl(identity, {
      cellId: LIMITED_CELL.id,
      assignmentEpoch: assignment.assignmentEpoch,
      generation: 1
    })
    await store.activateControl(identity, {
      cellId: LIMITED_CELL.id,
      assignmentEpoch: assignment.assignmentEpoch,
      generation: 1
    })

    expect(
      await database.query(
        `SELECT activity_id, request_units FROM relay_assignment_activity_leases
         WHERE user_id = ? AND relay_host_id = ?`,
        [identity.userId, identity.relayHostId]
      )
    ).toEqual([{ activity_id: 'control:limited:1', request_units: 1 }])
  })

  it('keeps expired pending reservations charged as late-arrival debt', async () => {
    let now = 100
    const { database, store } = await setup(449, () => now)
    await store.assign({ userId: 'user-1', relayHostId: 'host000000000001' })
    now += ASSIGNMENT_LIMITS.activityLeaseMs + 1
    await store.releaseExpiredActivityLeases()
    await store.recordCellHeartbeat({
      cellId: LIMITED_CELL.id,
      cellUrl: LIMITED_CELL.url,
      cellIncarnation: '11111111-1111-4111-8111-111111111111',
      startedAt: 50,
      ready: true,
      observedRequests: 0,
      totalConnections: 449,
      inFlightConnections: 0,
      reservedConnectionUnits: 0,
      enforcedConnectionUnits: 449,
      connectionHardCap: 600,
      connectionUnobservedBound: 50
    })

    await expect(
      store.assign({ userId: 'user-2', relayHostId: 'host000000000002' })
    ).rejects.toThrow('relay_capacity_exhausted')
    expect(
      await database.query(
        `SELECT activity_id FROM relay_assignment_activity_leases
         WHERE activity_kind = 'control' AND activity_id LIKE 'control-pending:%'`
      )
    ).toHaveLength(0)
    expect(
      await database.query(
        `SELECT state FROM relay_control_connection_reservations`
      )
    ).toEqual([{ state: 'late-arrival-debt' }])
  })

  it('reconciles late-arrival debt only after a covering absolute snapshot', async () => {
    let now = 100
    const { database, store } = await setup(449, () => now)
    const identity = { userId: 'late-user', relayHostId: 'latehost00000001' }
    const assignment = await store.assign(identity)
    now += ASSIGNMENT_LIMITS.activityLeaseMs + 1
    await store.releaseExpiredActivityLeases()
    await store.recordCellHeartbeat({
      cellId: LIMITED_CELL.id,
      cellUrl: LIMITED_CELL.url,
      cellIncarnation: '11111111-1111-4111-8111-111111111111',
      startedAt: 50,
      ready: true,
      observedRequests: 0,
      totalConnections: 449,
      inFlightConnections: 0,
      reservedConnectionUnits: 0,
      enforcedConnectionUnits: 449,
      connectionInclusionWatermark: 4,
      connectionHardCap: 600,
      connectionUnobservedBound: 50
    })

    await store.activateControl(identity, {
      cellId: LIMITED_CELL.id,
      assignmentEpoch: assignment.assignmentEpoch,
      generation: 1,
      connectionInclusionWatermark: 5
    })
    expect(
      await database.query(
        `SELECT state, inclusion_watermark FROM relay_control_connection_reservations`
      )
    ).toEqual([{ state: 'claimed', inclusion_watermark: 5 }])

    await store.recordCellHeartbeat({
      cellId: LIMITED_CELL.id,
      cellUrl: LIMITED_CELL.url,
      cellIncarnation: '11111111-1111-4111-8111-111111111111',
      startedAt: 50,
      ready: true,
      observedRequests: 0,
      totalConnections: 450,
      inFlightConnections: 0,
      reservedConnectionUnits: 0,
      enforcedConnectionUnits: 450,
      connectionInclusionWatermark: 5,
      connectionHardCap: 600,
      connectionUnobservedBound: 50
    })
    expect(
      await database.query(
        `SELECT state, released_at FROM relay_control_connection_reservations`
      )
    ).toEqual([{ state: 'released', released_at: now }])
    await expect(
      store.assign({ userId: 'blocked-user', relayHostId: 'blockedhost00001' })
    ).rejects.toThrow('relay_capacity_exhausted')
  })

  it('rejects duplicate and out-of-order absolute snapshots', async () => {
    const { database, store } = await setup(0)
    const heartbeat = {
      cellId: LIMITED_CELL.id,
      cellUrl: LIMITED_CELL.url,
      cellIncarnation: '11111111-1111-4111-8111-111111111111',
      startedAt: 50,
      ready: true,
      observedRequests: 0,
      totalConnections: 10,
      inFlightConnections: 0,
      reservedConnectionUnits: 0,
      enforcedConnectionUnits: 10,
      connectionInclusionWatermark: 10,
      connectionHardCap: 600 as const,
      connectionUnobservedBound: 50
    }
    await store.recordCellHeartbeat(heartbeat)
    await expect(store.recordCellHeartbeat(heartbeat)).rejects.toThrow(
      'stale_connection_snapshot'
    )
    await expect(
      store.recordCellHeartbeat({
        ...heartbeat,
        totalConnections: 9,
        enforcedConnectionUnits: 9,
        connectionInclusionWatermark: 9
      })
    ).rejects.toThrow('stale_connection_snapshot')
    expect(
      await database.query(
        `SELECT inclusion_watermark, enforced_connection_units
         FROM relay_cell_connection_snapshots`
      )
    ).toEqual([{ inclusion_watermark: 10, enforced_connection_units: 10 }])
  })

  it('keeps crash retries bound to one reservation claim', async () => {
    let now = 100
    const { database, store } = await setup(448, () => now)
    const identity = { userId: 'retry-user', relayHostId: 'retryhost0000001' }
    const assignment = await store.assign(identity)
    await new RelayAssignmentStore(database, () => now, {
      requireLiveCells: true,
      heartbeatTtlMs: 45_000
    }).assign(identity)
    expect(
      await database.query(
        `SELECT state FROM relay_control_connection_reservations`
      )
    ).toEqual([{ state: 'reserved' }])
    now += ASSIGNMENT_LIMITS.activityLeaseMs + 1
    await store.releaseExpiredActivityLeases()
    await store.recordCellHeartbeat({
      cellId: LIMITED_CELL.id,
      cellUrl: LIMITED_CELL.url,
      cellIncarnation: '11111111-1111-4111-8111-111111111111',
      startedAt: 50,
      ready: true,
      observedRequests: 0,
      totalConnections: 448,
      inFlightConnections: 0,
      reservedConnectionUnits: 0,
      enforcedConnectionUnits: 448,
      connectionHardCap: 600,
      connectionUnobservedBound: 50
    })
    await store.assign(identity)
    const restarted = new RelayAssignmentStore(database, () => now, {
      requireLiveCells: true,
      heartbeatTtlMs: 45_000
    })

    const activation = {
      cellId: LIMITED_CELL.id,
      assignmentEpoch: assignment.assignmentEpoch,
      generation: 1,
      connectionInclusionWatermark: 5
    }
    await restarted.activateControl(identity, activation)
    await restarted.activateControl(identity, activation)

    expect(
      await database.query(
        `SELECT state, claim_activity_id
         FROM relay_control_connection_reservations
         ORDER BY created_at ASC, reservation_id ASC`
      )
    ).toEqual([{ state: 'claimed', claim_activity_id: 'control:limited:1' }])
  })

  it('releases only redundant expired debt after a fresh absolute snapshot', async () => {
    let now = 100
    const { database, store } = await setup(449, () => now)
    const identity = { userId: 'debt-user', relayHostId: 'debthost000000001' }
    const assignment = await store.assign(identity)
    now += ASSIGNMENT_LIMITS.activityLeaseMs + 1
    await store.releaseExpiredActivityLeases()
    await database.query(
      `INSERT INTO relay_control_connection_reservations
       (reservation_id, idempotency_key, user_id, relay_host_id,
        assignment_epoch, cell_id, state, inclusion_watermark,
        claim_activity_id, created_at, timeout_at, claimed_at, released_at,
        updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'late-arrival-debt', NULL, NULL, ?, ?, NULL, NULL, ?)`,
      [
        'duplicate-reservation',
        'duplicate-reservation',
        identity.userId,
        identity.relayHostId,
        assignment.assignmentEpoch,
        LIMITED_CELL.id,
        101,
        now - 1,
        now
      ]
    )

    await store.recordCellHeartbeat({
      cellId: LIMITED_CELL.id,
      cellUrl: LIMITED_CELL.url,
      cellIncarnation: '11111111-1111-4111-8111-111111111111',
      startedAt: 50,
      ready: true,
      observedRequests: 0,
      totalConnections: 449,
      inFlightConnections: 0,
      reservedConnectionUnits: 0,
      enforcedConnectionUnits: 449,
      connectionInclusionWatermark: 5,
      connectionHardCap: 600,
      connectionUnobservedBound: 50
    })

    expect(
      await database.query(
        `SELECT state, COUNT(*) AS count
         FROM relay_control_connection_reservations
         GROUP BY state ORDER BY state`
      )
    ).toEqual([
      { state: 'late-arrival-debt', count: 1 },
      { state: 'released', count: 1 }
    ])
  })

  it('releases expired debt for a snapshot-proven aborted older epoch', async () => {
    const now = 1_000
    const { database, store } = await setup(0, () => now)
    const identity = { userId: 'aborted-user', relayHostId: 'abortedhost00001' }
    await database.query(
      `INSERT INTO relay_assignments
       (user_id, relay_host_id, cell_id, assignment_epoch, lease_expires_at,
        last_activity_at, reserved_controls, reserved_splices, reserved_invites,
        pending_installs, pending_confirmations, migration_leases)
       VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 0, 0)`,
      [identity.userId, identity.relayHostId, LIMITED_CELL.id, 3, now, now]
    )
    await database.query(
      `INSERT INTO relay_assignment_migrations
       (user_id, relay_host_id, source_cell_id, target_cell_id,
        previous_epoch, assignment_epoch, source_request_units,
        target_reserved_units, expires_at, target_registered_at,
        completed_at, aborted_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, 2, 0, 1, ?, ?, NULL, ?, ?, ?)`,
      [
        identity.userId,
        identity.relayHostId,
        'source',
        LIMITED_CELL.id,
        now - 2,
        now - 3,
        now - 1,
        now - 4,
        now - 1
      ]
    )
    await database.query(
      `INSERT INTO relay_control_connection_reservations
       (reservation_id, idempotency_key, user_id, relay_host_id,
        assignment_epoch, cell_id, state, inclusion_watermark,
        claim_activity_id, created_at, timeout_at, claimed_at, released_at,
        updated_at)
       VALUES (?, ?, ?, ?, 2, ?, 'late-arrival-debt', NULL, NULL, ?, ?, NULL, NULL, ?)`,
      [
        'aborted-reservation',
        'aborted-reservation',
        identity.userId,
        identity.relayHostId,
        LIMITED_CELL.id,
        now - 4,
        now - 2,
        now - 1
      ]
    )

    await store.recordCellHeartbeat({
      cellId: LIMITED_CELL.id,
      cellUrl: LIMITED_CELL.url,
      cellIncarnation: '11111111-1111-4111-8111-111111111111',
      startedAt: 50,
      ready: true,
      observedRequests: 0,
      totalConnections: 0,
      inFlightConnections: 0,
      reservedConnectionUnits: 0,
      enforcedConnectionUnits: 0,
      connectionInclusionWatermark: 5,
      connectionHardCap: 600,
      connectionUnobservedBound: 50
    })

    expect(
      await database.query(
        `SELECT state FROM relay_control_connection_reservations
         WHERE reservation_id = ?`,
        ['aborted-reservation']
      )
    ).toEqual([{ state: 'released' }])
  })

  it('fails a limited cell closed on stale telemetry while leaving legacy cells unchanged', async () => {
    let now = 100
    const { store } = await setup(0, () => now)
    now += 45_001
    await expect(
      store.assign({ userId: 'user-1', relayHostId: 'host000000000001' })
    ).rejects.toThrow('relay_capacity_exhausted')

    const legacyDatabase = await openInMemoryRelayDatabase()
    databases.push(legacyDatabase)
    const legacyStore = new RelayAssignmentStore(legacyDatabase, () => now, {
      requireLiveCells: true,
      heartbeatTtlMs: 45_000
    })
    const legacy = {
      id: 'legacy',
      url: 'https://legacy.example.com',
      capacityRequests: 10
    }
    await legacyStore.reconcileCells([legacy], true)
    await legacyStore.recordCellHeartbeat({
      cellId: legacy.id,
      cellUrl: legacy.url,
      cellIncarnation: '22222222-2222-4222-8222-222222222222',
      startedAt: now,
      ready: true,
      observedRequests: 0
    })
    await expect(
      legacyStore.assign({ userId: 'user-2', relayHostId: 'host000000000002' })
    ).resolves.toMatchObject({ cellId: 'legacy' })
  })

  it('does not create connection debt for mixed-version uncapped cells', async () => {
    let now = 100
    const legacy = {
      id: 'legacy',
      url: 'https://legacy.example.com',
      capacityRequests: 10
    }
    const { database, store } = await setup(0, () => now)
    await store.reconcileCells([legacy], true)
    await store.recordCellHeartbeat({
      cellId: legacy.id,
      cellUrl: legacy.url,
      cellIncarnation: '22222222-2222-4222-8222-222222222222',
      startedAt: 50,
      ready: true,
      observedRequests: 0
    })

    await store.assign({ userId: 'legacy-user', relayHostId: 'legacyhost000001' })
    expect(
      await database.query(`SELECT * FROM relay_control_connection_reservations`)
    ).toEqual([])
    expect(await store.releaseExpiredActivityLeases()).toBe(0)
    now += ASSIGNMENT_LIMITS.activityLeaseMs + 1
    expect(await store.releaseExpiredActivityLeases()).toBe(1)
    expect(
      await database.query(`SELECT * FROM relay_control_connection_reservations`)
    ).toEqual([])
  })

  it('rejects dormant rebalance before changing the assignment epoch', async () => {
    const now = ASSIGNMENT_LIMITS.dormantTtlMs + 100
    const database = await openInMemoryRelayDatabase()
    databases.push(database)
    const store = new RelayAssignmentStore(database, () => now, {
      requireLiveCells: true,
      heartbeatTtlMs: 45_000
    })
    const source = {
      id: 'source',
      url: 'https://source.example.com',
      capacityRequests: 10
    }
    await store.reconcileCells([source, LIMITED_CELL], true)
    await store.recordCellHeartbeat({
      cellId: source.id,
      cellUrl: source.url,
      cellIncarnation: '22222222-2222-4222-8222-222222222222',
      startedAt: now - 50,
      ready: true,
      observedRequests: 0
    })
    await store.recordCellHeartbeat({
      cellId: LIMITED_CELL.id,
      cellUrl: LIMITED_CELL.url,
      cellIncarnation: '11111111-1111-4111-8111-111111111111',
      startedAt: now - 50,
      ready: true,
      observedRequests: 0,
      totalConnections: 450,
      inFlightConnections: 0,
      reservedConnectionUnits: 0,
      enforcedConnectionUnits: 450,
      connectionHardCap: 600,
      connectionUnobservedBound: 50
    })
    const identity = { userId: 'dormant-user', relayHostId: 'dormanthost00001' }
    await database.query(
      `INSERT INTO relay_assignments
       (user_id, relay_host_id, cell_id, assignment_epoch, lease_expires_at,
        last_activity_at, reserved_controls, reserved_splices, reserved_invites,
        pending_installs, pending_confirmations, migration_leases)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        identity.userId,
        identity.relayHostId,
        source.id,
        7,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0
      ]
    )

    await expect(store.rebalanceDormant(identity, LIMITED_CELL.id)).rejects.toThrow(
      'relay_connection_headroom_exhausted'
    )
    expect(await store.resolve(identity)).toMatchObject({
      cellId: source.id,
      assignmentEpoch: 7
    })
    expect(await database.query(`SELECT * FROM relay_assignment_activity_leases`)).toEqual([])
  })

  it('rejects an evacuation target at its pause before migration mutation', async () => {
    const database = await openInMemoryRelayDatabase()
    databases.push(database)
    const store = new RelayAssignmentStore(database, () => 100, {
      requireLiveCells: true,
      heartbeatTtlMs: 45_000
    })
    const source = {
      id: 'source',
      url: 'https://source.example.com',
      capacityRequests: 10
    }
    await store.reconcileCells(
      [source, { ...LIMITED_CELL, initiallyEnabled: false }],
      true
    )
    await store.recordCellHeartbeat({
      cellId: source.id,
      cellUrl: source.url,
      cellIncarnation: '22222222-2222-4222-8222-222222222222',
      startedAt: 50,
      ready: true,
      observedRequests: 0
    })
    await store.recordCellHeartbeat({
      cellId: LIMITED_CELL.id,
      cellUrl: LIMITED_CELL.url,
      cellIncarnation: '11111111-1111-4111-8111-111111111111',
      startedAt: 50,
      ready: true,
      observedRequests: 0,
      totalConnections: 450,
      inFlightConnections: 0,
      reservedConnectionUnits: 0,
      enforcedConnectionUnits: 450,
      connectionHardCap: 600,
      connectionUnobservedBound: 50
    })
    const identity = { userId: 'user-1', relayHostId: 'host000000000001' }
    const assignment = await store.assign(identity)
    expect(assignment.cellId).toBe(source.id)
    await store.setCellEnabled(LIMITED_CELL.id, true)

    await expect(
      store.startEvacuation(identity, LIMITED_CELL.id)
    ).rejects.toThrow('relay_connection_headroom_exhausted')
    expect(await database.query(`SELECT * FROM relay_assignment_migrations`)).toEqual([])
    expect(await store.resolve(identity)).toMatchObject({
      cellId: source.id,
      assignmentEpoch: assignment.assignmentEpoch
    })
  })
})

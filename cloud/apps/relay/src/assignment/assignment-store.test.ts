import { ASSIGNMENT_LIMITS } from '@orca-cloud/relay-contract/assignment-invariants'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RelayCellConfig } from '../config.js'
import { RelayAssignmentStore } from './assignment-store.js'
import {
  encodeMembership,
  type CellAdmissionMembership
} from '../cell/admission/cell-admission-selector.js'
import {
  openInMemoryRelayDatabase,
  type RelayDatabase,
  type RelayLockOptions,
  type RelayTransactionOptions,
  type SqlRow
} from '../database/database.js'

const CELLS: RelayCellConfig[] = [
  { id: 'cell-a', url: 'https://relay-a.example.com', capacityRequests: 2 },
  { id: 'cell-b', url: 'https://relay-b.example.com', capacityRequests: 2 }
]

async function applyGenerationZeroSelector(
  store: RelayAssignmentStore,
  input: {
    attemptId: string
    membership: CellAdmissionMembership
  }
) {
  const current = (await store.inspectCellAdmissionSelector()).selector.membership
  return await store.applyCellAdmissionSelector({
    ...input,
    expectedGeneration: 0,
    expectedMembershipSha256: createHash('sha256').update(encodeMembership(current)).digest('hex')
  })
}

// Runs a side effect between the sticky lane and the placement lane, the window
// in which a host can acquire control after the sticky read called it dormant.
class SeedBetweenAssignmentLanesDatabase implements RelayDatabase {
  private transactions = 0
  private armed = false

  constructor(
    private readonly delegate: RelayDatabase,
    private readonly seed: () => Promise<void>
  ) {}

  arm(): void {
    this.armed = true
    this.transactions = 0
  }

  async query(sql: string, params: unknown[] = []): Promise<SqlRow[]> {
    return await this.delegate.query(sql, params)
  }

  async queryLocked(
    sql: string,
    params: unknown[] = [],
    options: RelayLockOptions = {}
  ): Promise<SqlRow[]> {
    return await this.delegate.queryLocked(sql, params, options)
  }

  async transaction<T>(
    operation: (transaction: RelayDatabase) => Promise<T>,
    options?: RelayTransactionOptions
  ): Promise<T> {
    if (this.armed && ++this.transactions === 2) await this.seed()
    return await this.delegate.transaction(operation, options)
  }

  async close(): Promise<void> {
    await this.delegate.close()
  }
}

describe('RelayAssignmentStore', () => {
  let database: RelayDatabase | undefined

  afterEach(async () => await database?.close())

  async function setup(now: () => number, cells = CELLS): Promise<RelayAssignmentStore> {
    database = await openInMemoryRelayDatabase()
    const store = new RelayAssignmentStore(database, now)
    await store.reconcileCells(cells)
    return store
  }

  async function setupWithHeartbeats(
    now: () => number,
    cells = CELLS
  ): Promise<RelayAssignmentStore> {
    database = await openInMemoryRelayDatabase()
    const store = new RelayAssignmentStore(database, now, {
      requireLiveCells: true,
      heartbeatTtlMs: 45_000
    })
    await store.reconcileCells(cells)
    return store
  }

  async function heartbeat(
    store: RelayAssignmentStore,
    cell = CELLS[0]!,
    input: {
      incarnation?: string
      startedAt?: number
      ready?: boolean
      observedRequests?: number
    } = {}
  ): Promise<void> {
    await store.recordCellHeartbeat({
      cellId: cell.id,
      cellUrl: cell.url,
      cellIncarnation: input.incarnation ?? '11111111-1111-4111-8111-111111111111',
      startedAt: input.startedAt ?? 50,
      ready: input.ready ?? true,
      observedRequests: input.observedRequests ?? 0,
      ...(cell.connectionHardCap === undefined
        ? {}
        : {
            totalConnections: 0,
            inFlightConnections: 0,
            reservedConnectionUnits: 0,
            enforcedConnectionUnits: 0,
            connectionHardCap: cell.connectionHardCap,
            connectionUnobservedBound: cell.connectionUnobservedBound
          })
    })
  }

  it('moves a stranded host off an existing-only cell that stopped serving it', async () => {
    // C3 rejected attaches on an existing-only cell; repeated grants defeated dormancy (#194, #225). Use recent failed grants on assignment rows: no cap reservations exist, and expired leases are pruned.
    let now = 100
    const store = await setup(() => now)
    const identity = { userId: 'user-a', relayHostId: 'host000000000001' }
    const first = await store.assign(identity)
    await store.setCellEnabled(first.cellId, false)

    // The pin holds while the last grant is young enough to still attach.
    now += 10_000
    const pinned = await store.assign(identity)
    expect(pinned.cellId).toBe(first.cellId)

    // The grant had ample time to attach and produced nothing live.
    now += 61_000
    const moved = await store.assign(identity)
    expect(moved.cellId).not.toBe(first.cellId)
    expect(moved.assignmentEpoch).toBe(first.assignmentEpoch + 1)

    // The move is durable: no bounce back to the closed cell.
    now += 1_000
    const settled = await store.assign(identity)
    expect(settled.cellId).toBe(moved.cellId)
    expect(settled.assignmentEpoch).toBe(moved.assignmentEpoch)
  })

  it('re-pins a host that took control after the sticky lane read it dormant', async () => {
    const now = 100
    const delegate = await openInMemoryRelayDatabase()
    const identity = { userId: 'user-a', relayHostId: 'host000000000001' }
    const seeded = new SeedBetweenAssignmentLanesDatabase(delegate, async () => {
      await delegate.query(
        `INSERT INTO relay_assignment_activity_leases
         (user_id, relay_host_id, activity_id, activity_kind, cell_id,
          request_units, expires_at, updated_at)
         VALUES (?, ?, 'control:cell-a:1', 'control', 'cell-a', 1, ?, ?),
                (?, ?, 'control-pending:1', 'control', 'cell-a', 1, ?, ?)`,
        [
          identity.userId,
          identity.relayHostId,
          now + ASSIGNMENT_LIMITS.activityLeaseMs,
          now,
          identity.userId,
          identity.relayHostId,
          now + ASSIGNMENT_LIMITS.activityLeaseMs,
          now
        ]
      )
      await delegate.query(
        `UPDATE relay_assignments SET reserved_controls = 2
         WHERE user_id = ? AND relay_host_id = ?`,
        [identity.userId, identity.relayHostId]
      )
      await delegate.query(`UPDATE relay_cells SET reserved_requests = 2 WHERE cell_id = 'cell-a'`)
    })
    database = seeded
    const store = new RelayAssignmentStore(seeded, () => now)
    await store.reconcileCells(CELLS)
    await delegate.query(
      `INSERT INTO relay_assignments
       (user_id, relay_host_id, cell_id, assignment_epoch, lease_expires_at,
        last_activity_at, reserved_controls, reserved_splices, reserved_invites,
        pending_installs, pending_confirmations, migration_leases)
       VALUES (?, ?, 'cell-a', 1, ?, ?, 0, 0, 0, 0, 0, 0)`,
      [identity.userId, identity.relayHostId, now, now - ASSIGNMENT_LIMITS.dormantTtlMs]
    )
    seeded.arm()

    await expect(store.assign(identity)).resolves.toMatchObject({
      cellId: 'cell-a',
      assignmentEpoch: 1
    })
    expect(
      await delegate.query(
        `SELECT reserved_controls FROM relay_assignments
         WHERE user_id = ? AND relay_host_id = ?`,
        [identity.userId, identity.relayHostId]
      )
    ).toEqual([{ reserved_controls: 2 }])
    expect(await cellReservations(delegate)).toEqual({ 'cell-a': 2, 'cell-b': 0 })
    expect(
      await delegate.query(
        `SELECT lease_expires_at, last_activity_at FROM relay_assignments
         WHERE user_id = ? AND relay_host_id = ?`,
        [identity.userId, identity.relayHostId]
      )
    ).toEqual([
      { lease_expires_at: now + ASSIGNMENT_LIMITS.activityLeaseMs, last_activity_at: now }
    ])
  })

  // Disabled registered targets satisfy neither completion nor expiry rollback, stranding migration rows.
  async function wedgeRegisteredMigration(
    now: () => number,
    cells: RelayCellConfig[],
    disableTarget = true,
    disableSource = true,
    releaseSourceControl = true
  ): Promise<{
    store: RelayAssignmentStore
    identity: { userId: string; relayHostId: string }
  }> {
    const store = await setupWithHeartbeats(now, cells)
    await heartbeat(store, cells[0]!)
    await heartbeat(store, cells[1]!)
    const identity = { userId: 'user-a', relayHostId: 'host000000000001' }
    const first = await store.assign(identity)
    const sourceControl = await store.activateControl(identity, {
      cellId: first.cellId,
      assignmentEpoch: first.assignmentEpoch,
      generation: 1
    })
    const migration = await store.startEvacuation(identity, 'cell-b')
    const targetControl = await store.activateControl(identity, {
      cellId: 'cell-b',
      assignmentEpoch: migration.assignmentEpoch,
      generation: 1
    })
    await store.markMigrationTargetRegistered(identity, {
      cellId: 'cell-b',
      assignmentEpoch: migration.assignmentEpoch
    })
    if (releaseSourceControl) await store.releaseActivity(identity, sourceControl)
    if (disableSource) await store.setCellEnabled('cell-a', false)
    // The desktop leaves the half-migrated target, then an operator disables that cell.
    await store.releaseActivity(identity, targetControl)
    if (disableTarget) await store.setCellEnabled('cell-b', false)
    return { store, identity }
  }

  it('preserves a fresh target grant created after abandoned migration selection', async () => {
    let now = 100
    const cells: RelayCellConfig[] = [
      {
        id: 'cell-a',
        url: 'https://relay-a.example.com',
        capacityRequests: 10,
        connectionHardCap: 600,
        connectionUnobservedBound: 50
      },
      {
        id: 'cell-b',
        url: 'https://relay-b.example.com',
        capacityRequests: 10,
        connectionHardCap: 600,
        connectionUnobservedBound: 50
      }
    ]
    const { store, identity } = await wedgeRegisteredMigration(() => now, cells, false)
    await applyGenerationZeroSelector(store, {
      attemptId: 'retired_source_fresh_target_grant',
      membership: {
        existingOnly: ['cell-a'],
        migrationOnly: ['cell-b'],
        general: []
      }
    })

    now += 45_001
    await heartbeat(store, cells[1]!)
    await store.adoptLegacyCellFence('cell-a', '11111111-1111-4111-8111-111111111111')
    await store.commitLegacyCellFenceAdoption('cell-a', '11111111-1111-4111-8111-111111111111')
    now += ASSIGNMENT_LIMITS.migrationLeaseMs + 1
    await heartbeat(store, cells[1]!)
    const query = database!.query.bind(database)
    let grant: Awaited<ReturnType<typeof store.assign>> | undefined
    vi.spyOn(database!, 'query').mockImplementationOnce(async (sql, params) => {
      const rows = await query(sql, params)
      grant = await store.assign(identity)
      return rows
    })

    expect(await store.abortExpiredEvacuations()).toBe(0)
    expect(grant).toMatchObject({ cellId: 'cell-b', assignmentEpoch: 2 })
    expect(
      await database!.query(
        `SELECT activity_id, expires_at FROM relay_assignment_activity_leases
         WHERE user_id = ? AND relay_host_id = ? AND activity_id = ?`,
        [identity.userId, identity.relayHostId, 'control-pending:2']
      )
    ).toEqual([{ activity_id: 'control-pending:2', expires_at: grant!.leaseExpiresAt }])
    expect(
      await database!.query(
        `SELECT state FROM relay_control_connection_reservations
         WHERE user_id = ? AND relay_host_id = ? AND assignment_epoch = ?
           AND cell_id = ? AND state = 'reserved'`,
        [identity.userId, identity.relayHostId, 2, 'cell-b']
      )
    ).toEqual([{ state: 'reserved' }])

    await store.activateControl(identity, {
      cellId: grant!.cellId,
      assignmentEpoch: grant!.assignmentEpoch,
      generation: 2
    })
    expect(
      await database!.query(
        `SELECT activity_id FROM relay_assignment_activity_leases
         WHERE user_id = ? AND relay_host_id = ? AND activity_kind = 'control'`,
        [identity.userId, identity.relayHostId]
      )
    ).toEqual([{ activity_id: 'control:cell-b:2' }])
    expect(
      await database!.query(
        `SELECT completed_at FROM relay_assignment_migrations
         WHERE user_id = ? AND relay_host_id = ? AND assignment_epoch = ?`,
        [identity.userId, identity.relayHostId, 2]
      )
    ).toEqual([{ completed_at: null }])
  })
})

async function cellReservations(database: RelayDatabase): Promise<Record<string, number>> {
  const rows = await database.query(
    `SELECT cell_id, reserved_requests FROM relay_cells ORDER BY cell_id ASC`
  )
  return Object.fromEntries(rows.map((row) => [String(row.cell_id), Number(row.reserved_requests)]))
}

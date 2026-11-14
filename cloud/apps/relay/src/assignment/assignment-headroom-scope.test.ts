import { afterEach, describe, expect, it } from 'vitest'
import { RelayAssignmentStore } from './assignment-store.js'
import { openInMemoryRelayDatabase, type RelayDatabase } from '../database/database.js'

const NOW = 100_000
const identity = { userId: 'headroom-user', relayHostId: 'headroomhost0001' }

describe('assignment headroom admission', () => {
  let database: RelayDatabase | undefined
  afterEach(async () => await database?.close())

  async function setup() {
    database = await openInMemoryRelayDatabase()
    const store = new RelayAssignmentStore(database, () => NOW, {
      requireLiveCells: true,
      heartbeatTtlMs: 45_000
    })
    const cells = [
      {
        id: 'cell-00',
        url: 'https://cell-0.example.com',
        capacityRequests: 1_000,
        connectionHardCap: 600 as const,
        connectionUnobservedBound: 50
      }
    ]
    await store.reconcileCells(cells)
    for (const cell of cells) {
      await store.recordCellHeartbeat({
        cellId: cell.id,
        cellUrl: cell.url,
        cellIncarnation: '11111111-1111-4111-8111-111111111111',
        startedAt: NOW - 10,
        ready: true,
        observedRequests: 0,
        totalConnections: 0,
        inFlightConnections: 0,
        reservedConnectionUnits: 0,
        enforcedConnectionUnits: 0,
        connectionHardCap: 600,
        connectionUnobservedBound: 50
      })
    }
    await database.query(
      `INSERT INTO relay_assignments
       (user_id, relay_host_id, cell_id, assignment_epoch, lease_expires_at,
        last_activity_at, reserved_controls, reserved_splices, reserved_invites,
        pending_installs, pending_confirmations, migration_leases)
       VALUES (?, ?, 'cell-00', 1, ?, ?, 0, 0, 0, 0, 0, 0)`,
      [identity.userId, identity.relayHostId, NOW + 90_000, NOW]
    )
    await store.acquireActivity(identity, {
      activityId: 'existing-splice',
      kind: 'splice',
      cellId: 'cell-00'
    })
    return { store, database }
  }

  it.each([
    ['missing snapshot', `DELETE FROM relay_cell_connection_snapshots WHERE cell_id = 'cell-00'`],
    ['expired snapshot', `UPDATE relay_cell_connection_snapshots SET snapshot_at = ${NOW - 45_000} WHERE cell_id = 'cell-00'`],
    ['old incarnation', `UPDATE relay_cell_connection_snapshots SET cell_incarnation = 'old' WHERE cell_id = 'cell-00'`],
    ['capacity boundary', `UPDATE relay_cell_connection_snapshots SET enforced_connection_units = 450 WHERE cell_id = 'cell-00'`]
  ])('rejects the pinned active host with %s', async (_name, sql) => {
    const { store, database } = await setup()
    await database.query(sql)
    await expect(store.assign(identity)).rejects.toThrow('relay_connection_headroom_exhausted')
  })

  it('preserves admission for cells without a connection limit', async () => {
    const { store, database } = await setup()
    await database.query(`DELETE FROM relay_cell_connection_limits WHERE cell_id = 'cell-00'`)
    await expect(store.assign(identity)).resolves.toMatchObject({ cellId: 'cell-00' })
  })

  it('counts outstanding reservations at the admission boundary', async () => {
    const { store, database } = await setup()
    await database.query(
      `UPDATE relay_cell_connection_snapshots SET enforced_connection_units = 449
       WHERE cell_id = 'cell-00'`
    )
    await database.query(
      `INSERT INTO relay_control_connection_reservations
       (reservation_id, idempotency_key, user_id, relay_host_id, assignment_epoch,
        cell_id, state, created_at, timeout_at, updated_at)
       VALUES ('pending', 'pending', 'other-user', 'other-host', 1,
        'cell-00', 'reserved', ?, ?, ?)`,
      [NOW, NOW + 90_000, NOW]
    )
    await expect(store.assign(identity)).rejects.toThrow('relay_connection_headroom_exhausted')
  })
})

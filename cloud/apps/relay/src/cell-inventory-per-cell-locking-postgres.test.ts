import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { RelayAssignmentStore } from './assignment-store.js'
import { openRelayDatabase, type RelayDatabase } from './database.js'

const databaseUrl = process.env.ORCA_RELAY_TEST_POSTGRES_URL
const describePostgres = databaseUrl ? describe : describe.skip

// Sorted ascending, and the host is pinned to the LAST id on purpose: the
// fleet-wide lock is one ordered scan, so it holds every earlier row while it
// waits on the pinned one. Pinning to the first id would make the two locking
// models indistinguishable.
const cells = ['a', 'b', 'c'].map((suffix) => ({
  id: `percell-postgres-${suffix}`,
  url: `https://percell-postgres-${suffix}.example.com`,
  capacityRequests: 1_000,
  connectionHardCap: 600 as const,
  connectionUnobservedBound: 50
}))
const [cellA, cellB, cellC] = cells as [(typeof cells)[0], (typeof cells)[0], (typeof cells)[0]]
const identity = { userId: 'percell-postgres-user', relayHostId: 'percellhost00001' }

function heartbeat(cell: (typeof cells)[number]) {
  return {
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
    connectionInclusionWatermark: 1,
    connectionHardCap: 600 as const,
    connectionUnobservedBound: 50
  }
}

describePostgres('PostgreSQL per-cell inventory locking', () => {
  const databases: RelayDatabase[] = []

  beforeAll(async () => {
    for (let index = 0; index < 3; index++) {
      databases.push(await openRelayDatabase({ databaseUrl, dataDir: '' }))
    }
  })

  async function removeTestRows(database: RelayDatabase): Promise<void> {
    await database.query(
      `DELETE FROM relay_control_connection_reservations WHERE user_id LIKE 'percell-postgres-%'`
    )
    for (const table of [
      'relay_assignment_activity_leases',
      'relay_post_drain_migration_pins',
      'relay_assignment_migration_incarnations',
      'relay_assignment_migrations',
      'relay_assignment_region_preferences',
      'relay_assignments'
    ]) {
      await database.query(`DELETE FROM ${table} WHERE user_id LIKE 'percell-postgres-%'`)
    }
    for (const cell of cells) {
      for (const table of [
        'relay_cell_connection_snapshots',
        'relay_cell_connection_runtime',
        'relay_cell_connection_limits',
        'relay_cell_runtime',
        'relay_cells'
      ]) {
        await database.query(`DELETE FROM ${table} WHERE cell_id = ?`, [cell.id])
      }
    }
  }

  afterAll(async () => {
    if (databases[0]) await removeTestRows(databases[0])
    for (const connection of databases) await connection.close()
  })

  async function pinHostToLastCell(store: RelayAssignmentStore): Promise<void> {
    await store.reconcileCells(cells)
    for (const cell of cells) await store.recordCellHeartbeat(heartbeat(cell))
    await store.setCellEnabled(cellA.id, false)
    await store.setCellEnabled(cellB.id, false)
    const assignment = await store.assign(identity)
    expect(assignment.cellId).toBe(cellC.id)
    await store.setCellEnabled(cellA.id, true)
    await store.setCellEnabled(cellB.id, true)
  }

  async function lockWaiterAppeared(database: RelayDatabase): Promise<boolean> {
    const deadline = Date.now() + 4_000
    while (Date.now() < deadline) {
      const rows = await database.query(
        `SELECT count(*) AS waiting FROM pg_stat_activity
         WHERE datname = current_database() AND wait_event_type = 'Lock'`
      )
      if (Number(rows[0]!.waiting) > 0) return true
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    return false
  }

  // Why: a sticky refresh whose first NOWAIT probe loses retries by taking a
  // cell row before the assignment row. That retry used to take the whole
  // inventory, so one busy cell stalled every other cell's reconnects.
  it('waits only on the pinned cell row while refreshing a sticky assignment', async () => {
    await removeTestRows(databases[0]!)
    const store = new RelayAssignmentStore(databases[0]!, () => 100)
    await pinHostToLastCell(store)
    // A host whose control lease was already reaped still holds its pin; that
    // is the shape that reaches the cell-row probe instead of touchAssignment.
    await databases[0]!.query(
      `DELETE FROM relay_assignment_activity_leases WHERE user_id = ?`,
      [identity.userId]
    )

    let releaseRow!: () => void
    const rowReleased = new Promise<void>((resolve) => {
      releaseRow = resolve
    })
    let rowHeld!: () => void
    const rowHeldPromise = new Promise<void>((resolve) => {
      rowHeld = resolve
    })
    const holder = databases[1]!.transaction(async (transaction) => {
      await transaction.queryLocked(`SELECT * FROM relay_cells WHERE cell_id = ?`, [cellC.id])
      rowHeld()
      await rowReleased
    })
    await rowHeldPromise

    const refresh = store.assign(identity)
    expect(await lockWaiterAppeared(databases[2]!)).toBe(true)
    // The refresh is blocked on cell C. Every earlier row must still be free:
    // the ordered fleet-wide scan would be holding both of them by now.
    const heldWhileRefreshWaits: string[] = []
    await databases[2]!.transaction(async (transaction) => {
      for (const cell of [cellA, cellB]) {
        try {
          await transaction.queryLocked(
            `SELECT * FROM relay_cells WHERE cell_id = ?`,
            [cell.id],
            { failIfUnavailable: true }
          )
        } catch {
          heldWhileRefreshWaits.push(cell.id)
        }
      }
    })
    releaseRow()
    await holder

    expect(heldWhileRefreshWaits).toEqual([])
    expect((await refresh).cellId).toBe(cellC.id)
  }, 15_000)

  // Why: the counter moves by a delta now instead of an absolute value read
  // from a snapshot, so concurrent movement on the same cell must still sum.
  it('keeps a cell reservation exact under concurrent same-cell activity', async () => {
    await removeTestRows(databases[0]!)
    const store = new RelayAssignmentStore(databases[0]!, () => 100)
    await store.reconcileCells(cells)
    for (const cell of cells) await store.recordCellHeartbeat(heartbeat(cell))
    await store.setCellEnabled(cellA.id, false)
    await store.setCellEnabled(cellB.id, false)

    const hosts = Array.from({ length: 6 }, (_, index) => ({
      userId: `percell-postgres-user-${index}`,
      relayHostId: `percellhost0000${index}`
    }))
    const stores = databases.map((database) => new RelayAssignmentStore(database, () => 100))
    await Promise.all(hosts.map((host, index) => stores[index % stores.length]!.assign(host)))

    // One splice each (2 units) on the same cell, from three connections at once.
    await Promise.all(
      hosts.map((host, index) =>
        stores[index % stores.length]!.acquireActivity(host, {
          activityId: `splice:percell-${index}`,
          kind: 'splice',
          cellId: cellC.id
        })
      )
    )
    const afterAcquire = await databases[0]!.query(
      `SELECT reserved_requests FROM relay_cells WHERE cell_id = ?`,
      [cellC.id]
    )
    // 6 pending control grants + 6 splices at 2 units each.
    expect(Number(afterAcquire[0]!.reserved_requests)).toBe(6 + 12)

    await Promise.all(
      hosts.map((host, index) =>
        stores[index % stores.length]!.releaseActivity(host, `splice:percell-${index}`)
      )
    )
    const afterRelease = await databases[0]!.query(
      `SELECT reserved_requests FROM relay_cells WHERE cell_id = ?`,
      [cellC.id]
    )
    expect(Number(afterRelease[0]!.reserved_requests)).toBe(6)
    await store.setCellEnabled(cellA.id, true)
    await store.setCellEnabled(cellB.id, true)
  }, 15_000)
})

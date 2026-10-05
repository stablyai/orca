import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { RelayAssignmentStore } from './assignment-store.js'
import { openRelayDatabase, type RelayDatabase } from './database.js'

const databaseUrl = process.env.ORCA_RELAY_TEST_POSTGRES_URL
const describePostgres = databaseUrl ? describe : describe.skip

const cell = {
  id: 'accept-lock-postgres',
  url: 'https://accept-lock-postgres.example.com',
  capacityRequests: 2,
  connectionHardCap: 600 as const,
  connectionUnobservedBound: 50
}
const userId = 'accept-lock-postgres-user'
const first = { userId, relayHostId: 'acceptlockhost01' }
const second = { userId, relayHostId: 'acceptlockhost02' }

// Why: the accept path now enforces the capacity ceiling inside its single
// conditional cell-row write instead of behind a SELECT ... FOR UPDATE it held
// for the rest of the transaction. Two accepts reaching for the same last slot
// are what would expose a lost update if that check were no longer atomic.
describePostgres('PostgreSQL control accept without a held cell row', () => {
  const databases: RelayDatabase[] = []

  beforeAll(async () => {
    databases.push(
      await openRelayDatabase({ databaseUrl, dataDir: '' }),
      await openRelayDatabase({ databaseUrl, dataDir: '' })
    )
  })

  async function removeTestRows(database: RelayDatabase): Promise<void> {
    await database.query(
      `DELETE FROM relay_control_connection_reservations WHERE user_id = ?`,
      [userId]
    )
    for (const table of [
      'relay_control_capabilities',
      'relay_assignment_activity_leases',
      'relay_post_drain_migration_pins',
      'relay_assignment_migration_incarnations',
      'relay_assignment_migrations',
      'relay_assignments'
    ]) {
      await database.query(`DELETE FROM ${table} WHERE user_id = ?`, [userId])
    }
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

  afterAll(async () => {
    if (databases[0]) await removeTestRows(databases[0])
    for (const connection of databases) await connection.close()
  })

  it('lets exactly one of two racing accepts take the last capacity slot', async () => {
    await removeTestRows(databases[0]!)
    const stores = databases.map((database) => new RelayAssignmentStore(database, () => 100))
    await prepareCell(stores[0]!)

    // Both hosts hold a grant, then drop the control the grant reserved, so the
    // cell has exactly one free slot and two accepts that each want it.
    const epochs = new Map<string, number>()
    for (const identity of [first, second]) {
      const assignment = await stores[0]!.assign(identity)
      epochs.set(identity.relayHostId, assignment.assignmentEpoch)
      const control = await stores[0]!.activateControl(identity, {
        cellId: cell.id,
        assignmentEpoch: assignment.assignmentEpoch,
        generation: 1
      })
      await stores[0]!.releaseActivity(identity, control)
    }
    await databases[0]!.query(
      `UPDATE relay_cells SET reserved_requests = ? WHERE cell_id = ?`,
      [cell.capacityRequests - 1, cell.id]
    )
    await databases[0]!.query(
      `INSERT INTO relay_assignment_activity_leases
       (user_id, relay_host_id, activity_id, activity_kind, cell_id,
        request_units, expires_at, updated_at)
       VALUES (?, ?, 'splice:ballast', 'splice', ?, 1, 90100, 100)`,
      [userId, 'acceptlockhost03', cell.id]
    )

    const outcomes = await Promise.allSettled([
      stores[0]!.activateControl(first, {
        cellId: cell.id,
        assignmentEpoch: epochs.get(first.relayHostId)!,
        generation: 2
      }),
      stores[1]!.activateControl(second, {
        cellId: cell.id,
        assignmentEpoch: epochs.get(second.relayHostId)!,
        generation: 2
      })
    ])

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
    const rejection = outcomes.find((outcome) => outcome.status === 'rejected')
    expect(String((rejection as PromiseRejectedResult).reason)).toContain(
      'relay_capacity_exhausted'
    )
    const cells = await databases[0]!.query(
      `SELECT reserved_requests FROM relay_cells WHERE cell_id = ?`,
      [cell.id]
    )
    expect(Number(cells[0]!.reserved_requests)).toBe(cell.capacityRequests)
    const units = await databases[0]!.query(
      `SELECT COALESCE(SUM(request_units), 0) AS units
       FROM relay_assignment_activity_leases WHERE cell_id = ?`,
      [cell.id]
    )
    expect(Number(units[0]!.units)).toBe(cell.capacityRequests)
  }, 20_000)

  it('rebinds a control while another connection holds the cell row', async () => {
    await removeTestRows(databases[0]!)
    const store = new RelayAssignmentStore(databases[0]!, () => 100)
    await prepareCell(store)
    const assignment = await store.assign(first)
    await store.activateControl(first, {
      cellId: cell.id,
      assignmentEpoch: assignment.assignmentEpoch,
      generation: 1
    })

    let release!: () => void
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    let held!: () => void
    const heldPromise = new Promise<void>((resolve) => {
      held = resolve
    })
    const holder = databases[1]!.transaction(async (transaction) => {
      await transaction.queryLocked(`SELECT * FROM relay_cells WHERE cell_id = ?`, [cell.id])
      held()
      await released
    })
    await heldPromise

    // Retiring generation 1 and installing generation 2 leaves the cell's
    // reservation where it was, so the accept has no reason to wait on the row
    // at all. Reading it up front is what used to make it wait, and then fail
    // at the request-path lock bound.
    try {
      await expect(
        store.activateControl(first, {
          cellId: cell.id,
          assignmentEpoch: assignment.assignmentEpoch,
          generation: 2
        })
      ).resolves.toBe(`control:${cell.id}:2`)
    } finally {
      release()
      await holder
    }

    const cells = await databases[0]!.query(
      `SELECT reserved_requests FROM relay_cells WHERE cell_id = ?`,
      [cell.id]
    )
    const units = await databases[0]!.query(
      `SELECT COALESCE(SUM(request_units), 0) AS units
       FROM relay_assignment_activity_leases WHERE cell_id = ?`,
      [cell.id]
    )
    expect(Number(cells[0]!.reserved_requests)).toBe(Number(units[0]!.units))
  }, 20_000)

  async function prepareCell(store: RelayAssignmentStore): Promise<void> {
    await store.reconcileCells([cell])
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
      connectionInclusionWatermark: 1,
      connectionHardCap: 600,
      connectionUnobservedBound: 50
    })
  }

})

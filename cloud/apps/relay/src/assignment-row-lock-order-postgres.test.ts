import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { RelayAssignmentStore } from './assignment-store.js'
import { openRelayDatabase, type RelayDatabase } from './database.js'

const databaseUrl = process.env.ORCA_RELAY_TEST_POSTGRES_URL
const describePostgres = databaseUrl ? describe : describe.skip

const cells = [
  {
    id: 'row-lock-order-a',
    url: 'https://row-lock-order-a.example.com',
    capacityRequests: 200,
    connectionHardCap: 600 as const,
    connectionUnobservedBound: 50
  },
  {
    id: 'row-lock-order-b',
    url: 'https://row-lock-order-b.example.com',
    capacityRequests: 200,
    connectionHardCap: 600 as const,
    connectionUnobservedBound: 50
  }
]
const userId = 'row-lock-order-user'
const hosts = ['rowlockhost00001', 'rowlockhost00002', 'rowlockhost00003', 'rowlockhost00004'].map(
  (relayHostId) => ({ userId, relayHostId })
)

// Why a deadlock counter and not "it eventually succeeded": the transaction
// wrapper retries 40P01 three times, so a cycle that fires on every wave still
// reports success to the caller while burning the retry budget that turns into
// a 503 under load. PostgreSQL counts every detected cycle in pg_stat_database,
// which sees through the retry.
describePostgres('PostgreSQL row lock order', () => {
  const databases: RelayDatabase[] = []

  beforeAll(async () => {
    for (let index = 0; index < 4; index++) {
      databases.push(await openRelayDatabase({ databaseUrl, dataDir: '' }))
    }
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

  async function deadlockCount(): Promise<number> {
    const rows = await databases[0]!.query(
      `SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()`
    )
    return Number(rows[0]!.deadlocks)
  }

  it('runs the cell accept and the placement retry concurrently without a cycle', async () => {
    await removeTestRows(databases[0]!)
    const stores = databases.map((database) => new RelayAssignmentStore(database, () => 100))
    await stores[0]!.reconcileCells(cells)
    for (const cell of cells) {
      await stores[0]!.recordCellHeartbeat({
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
    const placements = new Map<string, { cellId: string; assignmentEpoch: number }>()
    for (const identity of hosts) {
      const assignment = await stores[0]!.assign(identity)
      placements.set(identity.relayHostId, assignment)
    }

    const before = await deadlockCount()
    // The accept path (host rows, then the cell row last) against the paths
    // that must read the inventory first: placement and evacuation.
    for (let round = 0; round < 12; round++) {
      await Promise.allSettled(
        hosts.flatMap((identity, index) => {
          const placement = placements.get(identity.relayHostId)!
          const store = stores[index % stores.length]!
          const other = stores[(index + 1) % stores.length]!
          return [
            store.activateControl(identity, {
              cellId: placement.cellId,
              assignmentEpoch: placement.assignmentEpoch,
              generation: round + 2
            }),
            other.assign(identity),
            other.startEvacuation(
              identity,
              placement.cellId === cells[0]!.id ? cells[1]!.id : cells[0]!.id
            )
          ]
        })
      )
    }
    const after = await deadlockCount()

    expect(after - before).toBe(0)
  }, 120_000)
})

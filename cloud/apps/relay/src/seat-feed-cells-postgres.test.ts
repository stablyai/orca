import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { RelayAssignmentStore } from './assignment-store.js'
import type { RelayCellConfig } from './config.js'
import { openRelayDatabase, type RelayDatabase } from './database.js'

// The seat-feed cell list (with the process incarnation the reserve switch keys on) on real PostgreSQL.

const databaseUrl = process.env.ORCA_RELAY_TEST_POSTGRES_URL
const describePostgres = databaseUrl ? describe : describe.skip

const run = randomUUID().slice(0, 8)
const cell: RelayCellConfig = {
  id: `feed-pg-${run}`,
  url: `https://feed-${run}.example.com`,
  capacityRequests: 10,
  connectionHardCap: 600,
  connectionUnobservedBound: 50
}
const INCARNATION = '22222222-2222-4222-8222-222222222222'

describePostgres('seat-feed cells on PostgreSQL', () => {
  let database: RelayDatabase

  beforeAll(async () => {
    database = await openRelayDatabase({ databaseUrl, dataDir: '/tmp' })
  })

  afterAll(async () => {
    for (const table of ['relay_cell_admission', 'relay_cell_regions', 'relay_cell_runtime', 'relay_cells']) {
      await database.query(`DELETE FROM ${table} WHERE cell_id = ?`, [cell.id])
    }
    await database.close()
  })

  it('lists a heartbeating cell with its incarnation', async () => {
    const store = new RelayAssignmentStore(database, () => 1_000, { requireLiveCells: true, heartbeatTtlMs: 45_000 })
    await store.reconcileCells([cell], false)
    expect((await store.seatFeedCells()).find((entry) => entry.cellId === cell.id)).not.toHaveProperty(
      'incarnation'
    )
    await store.recordCellHeartbeat({
      cellId: cell.id,
      cellUrl: cell.url,
      cellIncarnation: INCARNATION,
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
    expect((await store.seatFeedCells()).find((entry) => entry.cellId === cell.id)).toMatchObject({
      cellUrl: cell.url,
      requiredForComplete: true,
      incarnation: INCARNATION
    })
  })
})

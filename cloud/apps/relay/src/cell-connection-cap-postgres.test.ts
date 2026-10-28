import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ASSIGNMENT_CONNECTION_HEADROOM_QUERY } from './assignment-connection-headroom-query.js'
import { RelayAssignmentStore } from './assignment-store.js'
import type { RelayCellConfig } from './config.js'
import { openRelayDatabase, type RelayDatabase } from './database.js'

const databaseUrl = process.env.ORCA_RELAY_TEST_POSTGRES_URL
const describePostgres = databaseUrl ? describe : describe.skip
const CELL_PREFIX = 'connection-cap-min-postgres'
const CELL_ID = `${CELL_PREFIX}-single`
const FLEET_SIZE = 16

function cellConfig(id: string, connectionHardCap: 1_000 | 3_000): RelayCellConfig {
  return {
    id,
    url: `https://${id}.example.com`,
    capacityRequests: 1_000,
    connectionHardCap,
    connectionUnobservedBound: 60
  }
}
const configured = (connectionHardCap: 1_000 | 3_000): RelayCellConfig =>
  cellConfig(CELL_ID, connectionHardCap)

async function removeCells(database: RelayDatabase): Promise<void> {
  for (const table of [
    'relay_cell_connection_snapshots',
    'relay_cell_connection_runtime',
    'relay_cell_connection_limits',
    'relay_cell_capabilities',
    'relay_cell_rehome_safety',
    'relay_cell_runtime',
    'relay_cell_admission',
    'relay_cell_regions',
    'relay_cells'
  ]) {
    await database.query(`DELETE FROM ${table} WHERE cell_id LIKE ?`, [`${CELL_PREFIX}-%`])
  }
}

function storeOn(database: RelayDatabase): RelayAssignmentStore {
  return new RelayAssignmentStore(database, () => 100, {
    requireLiveCells: true,
    heartbeatTtlMs: 45_000
  })
}

async function heartbeat(
  store: RelayAssignmentStore,
  cell: RelayCellConfig,
  connectionHardCap: number,
  units: number
): Promise<void> {
  await store.recordCellHeartbeat({
    cellId: cell.id,
    cellUrl: cell.url,
    cellIncarnation: '11111111-1111-4111-8111-111111111111',
    startedAt: 50,
    ready: true,
    observedRequests: 0,
    totalConnections: units,
    inFlightConnections: 0,
    reservedConnectionUnits: 0,
    enforcedConnectionUnits: units,
    connectionHardCap,
    connectionUnobservedBound: 60
  })
}

describePostgres('PostgreSQL effective connection cap', () => {
  let database: RelayDatabase
  let racer: RelayDatabase

  beforeAll(async () => {
    database = await openRelayDatabase({ databaseUrl, dataDir: '' })
    racer = await openRelayDatabase({ databaseUrl, dataDir: '' })
    await removeCells(database)
  })

  afterAll(async () => {
    await removeCells(database)
    await racer.close()
    await database.close()
  })

  it('records the previous cap on a raise and places against the cell-reported cap', async () => {
    const store = storeOn(database)
    const beat = async (connectionHardCap: number, units: number): Promise<void> =>
      await heartbeat(store, configured(1_000), connectionHardCap, units)
    await store.reconcileCells([configured(1_000)], true)
    await beat(1_000, 10)
    // A pre-change director's row: no report stamped.
    await database.query(
      `UPDATE relay_cell_connection_limits SET reported_hard_cap = NULL WHERE cell_id = ?`,
      [CELL_ID]
    )

    await store.reconcileCells([configured(3_000)], true)
    const status = await store.cellDeploymentStatus(CELL_ID)
    expect(status.connectionCapacity).toMatchObject({
      hardCap: 3_000,
      reportedHardCap: 1_000,
      effectiveHardCap: 1_000,
      normalAdmissionPause: 840,
      heartbeatFresh: true
    })

    await beat(1_000, 839)
    const headroom = await database.query(
      `${ASSIGNMENT_CONNECTION_HEADROOM_QUERY} WHERE limits.cell_id = ?`,
      [CELL_ID]
    )
    expect(Number(headroom[0]?.effective_hard_cap)).toBe(1_000)
    await expect(beat(3_000, 0)).resolves.toBeUndefined()
    await expect(store.cellDeploymentStatus(CELL_ID)).resolves.toMatchObject({
      connectionCapacity: { reportedHardCap: 3_000, effectiveHardCap: 3_000 }
    })
  })

  it('keeps 16 raised cells placeable while a heartbeat races the raise', async () => {
    const ids = Array.from({ length: FLEET_SIZE }, (_, index) => `${CELL_PREFIX}-fleet-${index}`)
    const lower = ids.map((id) => cellConfig(id, 1_000))
    const director = storeOn(database)
    const otherInstance = storeOn(racer)
    await director.reconcileCells(lower, true)
    for (const cell of lower) await heartbeat(director, cell, 1_000, 10)

    // The heartbeat lands before or after the raise; either order must leave the same state.
    await Promise.all([
      director.reconcileCells(
        ids.map((id) => cellConfig(id, 3_000)),
        true
      ),
      heartbeat(otherInstance, lower[0]!, 1_000, 11)
    ])

    for (const id of ids) {
      await expect(director.cellDeploymentStatus(id)).resolves.toMatchObject({
        connectionCapacity: {
          hardCap: 3_000,
          reportedHardCap: 1_000,
          effectiveHardCap: 1_000,
          heartbeatFresh: true
        }
      })
      const rows = await database.query(
        `SELECT cell_id FROM relay_cell_connection_snapshots WHERE cell_id = ?`,
        [id]
      )
      expect(rows).toHaveLength(1)
    }
    // The old processes keep heartbeating their 1,000 under the raised config.
    for (const cell of lower) {
      await expect(heartbeat(otherInstance, cell, 1_000, 12)).resolves.toBeUndefined()
    }
  })
})

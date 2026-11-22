import { ASSIGNMENT_LIMITS } from '@orca-cloud/relay-contract/assignment-invariants'
import { afterEach, describe, expect, it } from 'vitest'
import { RelayAssignmentStore } from './assignment-store.js'
import type { RelayCellConfig } from '../config.js'
import { openInMemoryRelayDatabase, type RelayDatabase } from '../database/database.js'

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

describe('relay assignment connection headroom', () => {
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
      await database.query(`SELECT state, released_at FROM relay_control_connection_reservations`)
    ).toEqual([{ state: 'released', released_at: now }])
    await expect(
      store.assign({ userId: 'blocked-user', relayHostId: 'blockedhost00001' })
    ).rejects.toThrow('relay_capacity_exhausted')
  })
})

import { afterEach, describe, expect, it } from 'vitest'
import { RelayAssignmentStore } from '../assignment/assignment-store.js'
import type { RelayCellConfig } from '../config.js'
import { openInMemoryRelayDatabase, type RelayDatabase } from '../database/database.js'

const KEY_PREFIX = 'reconnect-claim'
const USER_ID = `${KEY_PREFIX}-user-1`
const RELAY_HOST_ID = 'reconnectclaim01'
const CELL: RelayCellConfig = {
  id: `${KEY_PREFIX}-cell`,
  url: `https://${KEY_PREFIX}-cell.example.com`,
  capacityRequests: 1_000,
  connectionHardCap: 600,
  connectionUnobservedBound: 50
}
const CELL_INCARNATION = '11111111-1111-4111-8111-111111111111'
const IDENTITY = { userId: USER_ID, relayHostId: RELAY_HOST_ID }
const CONTROL_ACTIVITY_ID = `control:${CELL.id}:1`

const databases: RelayDatabase[] = []

afterEach(async () => {
  for (const database of databases.splice(0)) {
    await database.close()
  }
})

async function setup(
  now: () => number
): Promise<{ database: RelayDatabase; store: RelayAssignmentStore }> {
  const database = await openInMemoryRelayDatabase()
  databases.push(database)
  const store = new RelayAssignmentStore(database, now, {
    requireLiveCells: true,
    heartbeatTtlMs: 45_000
  })
  await store.reconcileCells([CELL], false)
  await heartbeat(store, 0)
  return { database, store }
}

async function heartbeat(store: RelayAssignmentStore, watermark: number): Promise<void> {
  await store.recordCellHeartbeat({
    cellId: CELL.id,
    cellUrl: CELL.url,
    cellIncarnation: CELL_INCARNATION,
    startedAt: 50,
    ready: true,
    observedRequests: 0,
    totalConnections: 0,
    inFlightConnections: 0,
    reservedConnectionUnits: 0,
    enforcedConnectionUnits: 0,
    connectionHardCap: CELL.connectionHardCap,
    connectionUnobservedBound: CELL.connectionUnobservedBound,
    connectionInclusionWatermark: watermark
  })
}

async function reservations(
  database: RelayDatabase
): Promise<{ state: string; claimActivityId: string | null }[]> {
  const rows = await database.query(
    `SELECT state, claim_activity_id FROM relay_control_connection_reservations
     WHERE user_id = ? ORDER BY created_at ASC, reservation_id ASC`,
    [USER_ID]
  )
  return rows.map((row) => ({
    state: String(row['state']),
    claimActivityId:
      row['claim_activity_id'] === null || row['claim_activity_id'] === undefined
        ? null
        : String(row['claim_activity_id'])
  }))
}

describe('control reservation claim on reconnect', () => {
  it('claims the fresh reservation when the same generation reconnects', async () => {
    let now = 100_000_000
    const { database, store } = await setup(() => now)

    const assignment = await store.assign(IDENTITY)
    await store.activateControl(IDENTITY, {
      cellId: CELL.id,
      assignmentEpoch: assignment.assignmentEpoch,
      generation: 1,
      connectionInclusionWatermark: 1
    })
    // Cell telemetry now includes the control, so its reservation is released.
    now += 1_000
    await heartbeat(store, 2)
    expect(await reservations(database)).toEqual([
      { state: 'released', claimActivityId: CONTROL_ACTIVITY_ID }
    ])

    // Control drops and the host is re-granted the same cell and epoch.
    now += 1_000
    await store.releaseActivity(IDENTITY, CONTROL_ACTIVITY_ID)
    now += 1_000
    await store.assign(IDENTITY)
    expect(await reservations(database)).toEqual([
      { state: 'released', claimActivityId: CONTROL_ACTIVITY_ID },
      { state: 'reserved', claimActivityId: null }
    ])

    now += 1_000
    await store.activateControl(IDENTITY, {
      cellId: CELL.id,
      assignmentEpoch: assignment.assignmentEpoch,
      generation: 1,
      connectionInclusionWatermark: 3
    })

    expect(await reservations(database)).toEqual([
      { state: 'released', claimActivityId: CONTROL_ACTIVITY_ID },
      { state: 'claimed', claimActivityId: CONTROL_ACTIVITY_ID }
    ])
  })

  it('still refuses to claim a second reservation while the first is outstanding', async () => {
    let now = 100_000_000
    const { database, store } = await setup(() => now)

    const assignment = await store.assign(IDENTITY)
    await store.activateControl(IDENTITY, {
      cellId: CELL.id,
      assignmentEpoch: assignment.assignmentEpoch,
      generation: 1,
      connectionInclusionWatermark: 1
    })
    await database.query(
      `INSERT INTO relay_control_connection_reservations
       (reservation_id, idempotency_key, user_id, relay_host_id, assignment_epoch,
        cell_id, state, claim_activity_id, created_at, timeout_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'reserved', NULL, ?, ?, ?)`,
      [
        `${KEY_PREFIX}-extra`,
        `${KEY_PREFIX}-extra`,
        USER_ID,
        RELAY_HOST_ID,
        assignment.assignmentEpoch,
        CELL.id,
        now + 1,
        now + 90_000,
        now + 1
      ]
    )

    now += 1_000
    await store.activateControl(IDENTITY, {
      cellId: CELL.id,
      assignmentEpoch: assignment.assignmentEpoch,
      generation: 1,
      connectionInclusionWatermark: 2
    })

    expect(await reservations(database)).toEqual([
      { state: 'claimed', claimActivityId: CONTROL_ACTIVITY_ID },
      { state: 'reserved', claimActivityId: null }
    ])
  })
})

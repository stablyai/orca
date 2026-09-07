import { afterEach, describe, expect, it } from 'vitest'
import { RelayAssignmentStore } from './assignment-store.js'
import type { RelayCellConfig } from './config.js'
import { openInMemoryRelayDatabase, type RelayDatabase } from './database.js'

const DEBT_RETENTION_MS = 10 * 60 * 1_000

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

async function setup(now: () => number): Promise<{
  database: RelayDatabase
  store: RelayAssignmentStore
}> {
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
    totalConnections: 0,
    inFlightConnections: 0,
    reservedConnectionUnits: 0,
    enforcedConnectionUnits: 0,
    connectionHardCap: 600,
    connectionUnobservedBound: 50
  })
  return { database, store }
}

async function insertDebt(
  database: RelayDatabase,
  reservationId: string,
  relayHostId: string,
  timeoutAt: number,
  claimActivityId: string | null = null
): Promise<void> {
  await database.query(
    `INSERT INTO relay_control_connection_reservations
     (reservation_id, idempotency_key, user_id, relay_host_id, assignment_epoch,
      cell_id, state, claim_activity_id, created_at, timeout_at, updated_at)
     VALUES (?, ?, 'user-1', ?, 1, ?, 'late-arrival-debt', ?, ?, ?, ?)`,
    [
      reservationId,
      reservationId,
      relayHostId,
      LIMITED_CELL.id,
      claimActivityId,
      timeoutAt - 10_000,
      timeoutAt,
      timeoutAt
    ]
  )
}

async function reservationStates(database: RelayDatabase): Promise<Map<string, string>> {
  const rows = await database.query(
    `SELECT reservation_id, state FROM relay_control_connection_reservations`
  )
  return new Map(rows.map((row) => [String(row['reservation_id']), String(row['state'])]))
}

describe('late-arrival debt retention', () => {
  it('releases unclaimed debt past retention and keeps fresh or claimed debt', async () => {
    const now = 100_000_000
    const { database, store } = await setup(() => now)
    await insertDebt(database, 'stale-debt', 'host000000000001', now - DEBT_RETENTION_MS - 1)
    await insertDebt(database, 'fresh-debt', 'host000000000002', now - 30_000)
    await insertDebt(
      database,
      'claimed-debt',
      'host000000000003',
      now - DEBT_RETENTION_MS - 1,
      'control:1'
    )

    await store.releaseExpiredActivityLeases()

    expect(await reservationStates(database)).toEqual(
      new Map([
        ['stale-debt', 'released'],
        ['fresh-debt', 'late-arrival-debt'],
        ['claimed-debt', 'late-arrival-debt']
      ])
    )
  })

  it('restores placement once stale debt no longer consumes connection headroom', async () => {
    const now = 100_000_000
    const { database, store } = await setup(() => now)
    // Headroom needs enforced + outstanding + unobserved(50) < hardCap(600) -
    // rebindReserve(100); 450 stale debt rows are exactly enough to block.
    for (let index = 0; index < 450; index++) {
      await insertDebt(
        database,
        `stale-${index}`,
        `host${String(index).padStart(12, '0')}`,
        now - DEBT_RETENTION_MS - 1
      )
    }
    await expect(
      store.assign({ userId: 'user-9', relayHostId: 'hostfffffffffff9' })
    ).rejects.toThrow('relay_capacity_exhausted')

    await store.releaseExpiredActivityLeases()

    await expect(
      store.assign({ userId: 'user-9', relayHostId: 'hostfffffffffff9' })
    ).resolves.toMatchObject({ cellId: LIMITED_CELL.id })
  })
})

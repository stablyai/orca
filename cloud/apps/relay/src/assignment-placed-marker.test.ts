import { ASSIGNMENT_LIMITS } from '@orca-cloud/relay-contract'
import { afterEach, describe, expect, it } from 'vitest'
import { RelayAssignmentStore } from './assignment-store.js'
import { openInMemoryRelayDatabase, type RelayDatabase } from './database.js'

const CELL = { id: 'cell-a', url: 'https://relay-a.example.com', capacityRequests: 10 }
const IDENTITY = { userId: 'user-a', relayHostId: 'host000000000001' }

describe('assign marks only the answers it minted as placed', () => {
  let database: RelayDatabase | undefined

  afterEach(async () => await database?.close())

  async function setup(now: () => number): Promise<RelayAssignmentStore> {
    database = await openInMemoryRelayDatabase()
    const store = new RelayAssignmentStore(database, now)
    await store.reconcileCells([CELL])
    return store
  }

  it('marks a fresh placement and leaves the existing row unmarked', async () => {
    const store = await setup(() => 100)
    const first = await store.assign(IDENTITY)
    const again = await store.assign(IDENTITY)

    expect(first.placed).toBe(true)
    expect(again).toMatchObject({ cellId: first.cellId, assignmentEpoch: first.assignmentEpoch })
    expect(again.placed).toBeUndefined()
  })

  it('marks a same-cell re-placement with a new epoch', async () => {
    let now = 100
    const store = await setup(() => now)
    const first = await store.assign(IDENTITY)
    await store.changeActivity(IDENTITY, 'control', -1)
    now += ASSIGNMENT_LIMITS.activityLeaseMs + 1
    await store.releaseExpiredActivityLeases()
    await store.releaseExpiredActivity()
    now += ASSIGNMENT_LIMITS.dormantTtlMs
    const replaced = await store.assign(IDENTITY)

    expect(replaced).toMatchObject({ cellId: first.cellId, assignmentEpoch: first.assignmentEpoch + 1 })
    expect(replaced.placed).toBe(true)
  })

  it('marks a reserve booking and keeps the returned assignment otherwise unchanged', async () => {
    const store = await setup(() => 100)
    const booking = {
      ...IDENTITY,
      cellId: 'reserve-c1',
      cellUrl: 'https://reserve-c1.example.com',
      assignmentEpoch: 9,
      leaseExpiresAt: 400_000,
      region: 'us-central1' as const
    }
    const booked = await store.assign(IDENTITY, undefined, undefined, undefined, {
      placeFresh: async () => booking
    })

    expect(booked).toEqual({ ...booking, placed: true })
  })
})

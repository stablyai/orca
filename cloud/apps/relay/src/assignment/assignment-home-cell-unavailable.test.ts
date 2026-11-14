import { afterEach, describe, expect, it } from 'vitest'
import { RelayAssignmentStore } from './assignment-store.js'
import type { RelayCellConfig } from '../config.js'
import { openInMemoryRelayDatabase, type RelayDatabase } from '../database/database.js'

const HEARTBEAT_TTL_MS = 45_000
const START_MS = 100
const IDENTITY = { userId: 'user-1', relayHostId: 'host000000000001' }

const databases: RelayDatabase[] = []

afterEach(async () => {
  for (const database of databases.splice(0)) await database.close()
})

interface Harness {
  store: RelayAssignmentStore
  heartbeat: (cell: RelayCellConfig, ready: boolean) => Promise<void>
  setNow: (value: number) => void
}

async function setup(cells: RelayCellConfig[]): Promise<Harness> {
  const database = await openInMemoryRelayDatabase()
  databases.push(database)
  let now = START_MS
  const store = new RelayAssignmentStore(database, () => now, {
    requireLiveCells: true,
    heartbeatTtlMs: HEARTBEAT_TTL_MS
  })
  await store.reconcileCells(cells, true)
  const heartbeat = async (cell: RelayCellConfig, ready: boolean): Promise<void> => {
    await store.recordCellHeartbeat({
      cellId: cell.id,
      cellUrl: cell.url,
      cellIncarnation: `1111111${cells.indexOf(cell)}-1111-4111-8111-111111111111`,
      startedAt: 50,
      ready,
      observedRequests: 0
    })
  }
  for (const cell of cells) await heartbeat(cell, true)
  return { store, heartbeat, setNow: (value: number) => (now = value) }
}

describe('home cell unavailable', () => {
  it('rehomes instead of rejecting when the unavailable cell needs no fence', async () => {
    const home: RelayCellConfig = {
      id: 'home',
      url: 'https://home.example.com',
      capacityRequests: 1_000
    }
    const spare: RelayCellConfig = {
      id: 'spare',
      url: 'https://spare.example.com',
      capacityRequests: 1_000
    }
    const { store, heartbeat, setNow } = await setup([home, spare])
    expect((await store.assign(IDENTITY)).cellId).toBe(home.id)
    setNow(START_MS + 1_000)
    await heartbeat(home, false)

    expect((await store.assign(IDENTITY)).cellId).toBe(spare.id)
  })
})

import { afterEach, describe, expect, it } from 'vitest'
import { RelayAssignmentStore } from '../assignment-store.js'
import type { RelayCellConfig } from '../../config.js'
import { openInMemoryRelayDatabase, type RelayDatabase } from '../../database/database.js'

const CELLS: RelayCellConfig[] = [
  { id: 'cell-a', url: 'https://relay-a.example.com', capacityRequests: 10 },
  { id: 'cell-b', url: 'https://relay-b.example.com', capacityRequests: 10 }
]

describe('dead-cell evacuation pre-check', () => {
  let database: RelayDatabase | undefined

  afterEach(async () => {
    await database?.close()
    database = undefined
  })

  async function setup(now: () => number) {
    database = await openInMemoryRelayDatabase()
    const store = new RelayAssignmentStore(database, now, {
      requireLiveCells: true,
      heartbeatTtlMs: 45_000
    })
    await store.reconcileCells(CELLS)
    return { store }
  }

  async function heartbeat(store: RelayAssignmentStore, cell: RelayCellConfig): Promise<void> {
    await store.recordCellHeartbeat({
      cellId: cell.id,
      cellUrl: cell.url,
      cellIncarnation: '11111111-1111-4111-8111-111111111111',
      startedAt: 50,
      ready: true,
      observedRequests: 0
    })
  }

  it('still evacuates hosts from a dead uncapped cell that admits', async () => {
    let now = 100
    const { store } = await setup(() => now)
    for (const cell of CELLS) await heartbeat(store, cell)
    const identity = { userId: 'user-a', relayHostId: 'host000000000001' }
    await store.setCellEnabled('cell-b', false)
    expect(await store.assign(identity)).toMatchObject({ cellId: 'cell-a' })
    await store.setCellEnabled('cell-b', true)
    now += 45_001
    await heartbeat(store, CELLS[1]!)

    expect(await store.evacuateDeadCells()).toBe(1)
    expect((await store.resolve(identity))?.cellId).toBe('cell-b')
  })
})

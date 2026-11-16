import { describe, expect, it } from 'vitest'
import { PlacementLoadBand } from './placement-load-band.js'
import { RelayAssignmentStore } from '../assignment-store.js'
import { openInMemoryRelayDatabase } from '../../database/database.js'

function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = Math.imul(state ^ (state >>> 15), 1 | state)
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296
  }
}

const quiet = () => undefined

describe('leastLoadedCell with the load band', () => {
  async function setupRegions() {
    const database = await openInMemoryRelayDatabase()
    const store = new RelayAssignmentStore(database, () => 1_000, {
      placementLoadBand: new PlacementLoadBand(seededRandom(13), quiet)
    })
    const asia = ['asia-a', 'asia-b', 'asia-c', 'asia-d', 'asia-e']
    await store.reconcileCells([
      ...asia.map((id) => ({
        id,
        url: `https://${id}.example.com`,
        capacityRequests: 100,
        region: 'asia-east2' as const
      })),
      {
        id: 'us-a',
        url: 'https://us-a.example.com',
        capacityRequests: 1000,
        region: 'us-central1' as const
      }
    ])
    await database.query(
      `UPDATE relay_cells SET observed_requests = 35 WHERE cell_id IN (?, ?, ?, ?)`,
      asia.slice(1)
    )
    return { database, store }
  }

  async function placements(store: RelayAssignmentStore, count: number) {
    const counts = new Map<string, number>()
    for (let index = 0; index < count; index += 1) {
      const assignment = await store.assign(
        { userId: `user-${index}`, relayHostId: `host${String(index).padStart(12, '0')}` },
        'asia-east2'
      )
      counts.set(assignment.cellId, (counts.get(assignment.cellId) ?? 0) + 1)
    }
    return counts
  }

  it('fills the preferred region to its hard cap before spilling, never past it', async () => {
    const { database, store } = await setupRegions()
    try {
      const counts = await placements(store, 520)
      const rows = await database.query(
        `SELECT reserved_requests, capacity_requests FROM relay_cells`
      )

      // The hard cap is reserved < capacity: five Asia cells hold 500, the rest spill to the US.
      expect(counts.get('us-a')).toBe(20)
      for (const row of rows) {
        expect(Number(row.reserved_requests)).toBeLessThanOrEqual(Number(row.capacity_requests))
      }
    } finally {
      await database.close()
    }
  })
})

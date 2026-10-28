import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { claimDeadManTripSlot, DEAD_MAN_SLOT_HOLD_MS } from './cell-dead-man-trip-slot.js'
import { openRelayDatabase, type RelayDatabase } from './database.js'

// Concurrent claims on real PostgreSQL: a director outage trips at most `slots` cells, however
// many claim at the same moment.

const databaseUrl = process.env.ORCA_RELAY_TEST_POSTGRES_URL
const describePostgres = databaseUrl ? describe : describe.skip

const run = randomUUID().slice(0, 8)
const cells = Array.from({ length: 8 }, (_, index) => `slots-pg-${index}-${run}`)
const TABLES = ['relay_cell_admit_effective', 'relay_cell_admit_modes']

describePostgres('dead-man trip slots on PostgreSQL', () => {
  let database: RelayDatabase
  const now = Date.now()

  beforeAll(async () => {
    database = await openRelayDatabase({ databaseUrl, dataDir: '/tmp', poolMax: cells.length })
    for (const cellId of cells) {
      await database.query(`INSERT INTO relay_cell_admit_modes (cell_id, admit_mode, updated_at) VALUES (?, 'reserve', ?)`, [cellId, now])
    }
  })

  afterAll(async () => {
    for (const table of TABLES) {
      for (const cellId of cells) {
        await database.query(`DELETE FROM ${table} WHERE cell_id = ?`, [cellId])
      }
    }
    await database.close()
  })

  const claim = async (cellId: string, slots: number) =>
    await claimDeadManTripSlot(database, {
      cellId,
      cellIncarnation: `inc-${cellId}`,
      slots,
      now
    })

  it('grants at most the free slots to cells that claim together, and frees one whose holder stopped writing', async () => {
    // A claim that finds the lock taken returns false and retries later, so keep claiming.
    const granted = cells.map(() => false)
    for (let round = 0; round < 5; round += 1) {
      const results = await Promise.all(
        cells.map(async (cellId, index) => (granted[index] ? false : await claim(cellId, 2)))
      )
      results.forEach((won, index) => (granted[index] ||= won))
    }
    expect(granted.filter(Boolean)).toHaveLength(2)
    const rows = await database.query(
      `SELECT cell_id FROM relay_cell_admit_effective WHERE mode = 'db' AND cell_id LIKE ?`,
      [`slots-pg-%-${run}`]
    )
    expect(rows).toHaveLength(2)
    // A holder that re-claims keeps its own slot: it never counts itself.
    const holder = cells[granted.indexOf(true)]!
    expect(await claim(holder, 2)).toBe(true)

    // A holder that keeps its row fresh keeps its slot; one that stopped writing gives it up.
    const waiting = cells.filter((_, index) => !granted[index])
    expect(await claim(waiting[0]!, 2)).toBe(false)
    await database.query(`UPDATE relay_cell_admit_effective SET updated_at = ? WHERE cell_id = ?`, [now - DEAD_MAN_SLOT_HOLD_MS - 1, holder])
    const second = new Set<string>()
    for (let round = 0; round < 5; round += 1) {
      await Promise.all(
        waiting.map(async (cellId) => {
          if (!second.has(cellId) && (await claim(cellId, 2))) {
            second.add(cellId)
          }
        })
      )
    }
    expect(second.size).toBe(1)
  })
})

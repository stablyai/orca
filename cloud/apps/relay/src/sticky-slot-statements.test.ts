import { performance } from 'node:perf_hooks'
import { describe, expect, it, vi } from 'vitest'
import { runInStickySlot, StickySlotStatements } from './sticky-slot-statements.js'
import {
  ScriptedPoolClient,
  scriptedPostgresDatabase
} from './test-fixtures/scripted-postgres-pool.js'

function gated() {
  let open!: () => void
  const opened = new Promise<void>((resolve) => (open = resolve))
  return { open, wait: async () => await opened }
}

describe('sticky slot statements', () => {
  it('charges the slot every round trip it made, by pooled connection', async () => {
    const first = new ScriptedPoolClient()
    const second = new ScriptedPoolClient()
    const database = scriptedPostgresDatabase([first, second, first])
    const slot = new StickySlotStatements()
    await runInStickySlot(slot, async () => {
      await database.query('SELECT verify')
      await database.transaction(async (transaction) => {
        await transaction.query('SELECT pin')
        await transaction.queryLocked('SELECT row', [], { lockTimeoutMs: 200 })
      })
    })
    // Outside the slot: not this request's work.
    await database.query('SELECT other')

    const sample = slot.close()
    // BEGIN, the statement, both lock_timeout SETs, the locked read and COMMIT.
    expect(second.statements).toHaveLength(6)
    expect(sample.statements).toBe(7)
    expect(sample.sqlMs).toBeGreaterThanOrEqual(0)
    expect(
      [...sample.statementMsByConnection].map(([id, samples]) => [id, samples.length])
    ).toEqual([
      [1, 1],
      [2, 6]
    ])
  })

  it('leaves out statements another request runs while the slot is held', async () => {
    const otherGate = gated()
    const database = scriptedPostgresDatabase([
      new ScriptedPoolClient(otherGate.wait),
      new ScriptedPoolClient()
    ])
    const slot = new StickySlotStatements()
    const other = database.query('SELECT other')
    await runInStickySlot(slot, async () => {
      await database.query('SELECT mine')
      otherGate.open()
      await other
    })

    const sample = slot.close()
    expect(sample.statements).toBe(1)
    expect([...sample.statementMsByConnection.keys()]).toEqual([2])
  })

  it('ignores work the request left running after it released the slot', async () => {
    const late = gated()
    const database = scriptedPostgresDatabase([new ScriptedPoolClient(), new ScriptedPoolClient()])
    const slot = new StickySlotStatements()
    let leftRunning: Promise<unknown> | undefined
    await runInStickySlot(slot, async () => {
      await database.query('SELECT 1')
      leftRunning = late.wait().then(async () => await database.query('SELECT late'))
    })
    const sample = slot.close()
    late.open()
    await leftRunning
    expect(sample.statements).toBe(1)
  })

  it('reports the pool wait apart from the statements', async () => {
    let now = 0
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now)
    const database = scriptedPostgresDatabase(
      [
        new ScriptedPoolClient(async () => {
          now += 7
        })
      ],
      () => {
        now += 30
      }
    )
    try {
      const slot = new StickySlotStatements()
      await runInStickySlot(slot, async () => await database.query('SELECT 1'))
      const sample = slot.close()
      expect(sample.poolWaitMs).toBe(30)
      expect(sample.sqlMs).toBe(7)
    } finally {
      clock.mockRestore()
    }
  })

  it('names each pooled connection once, however often it is checked out', async () => {
    const first = new ScriptedPoolClient()
    const second = new ScriptedPoolClient()
    const database = scriptedPostgresDatabase([first, second, first])
    const slot = new StickySlotStatements()
    await runInStickySlot(slot, async () => {
      for (let index = 0; index < 3; index++) await database.query('SELECT 1')
    })

    expect(
      [...slot.close().statementMsByConnection].map(([id, samples]) => [id, samples.length])
    ).toEqual([
      [1, 2],
      [2, 1]
    ])
  })
})

import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PostgresDatabase } from './database.js'
import { SLOW_CONNECTION_WINDOW } from './postgres-connection-latency.js'

let clock = 0

type Slot = { name: string; statementMs: () => number }

// Hands out its connections in turn; a client released with a truthy value is replaced by a fresh
// 3 ms one, as pg-pool would dial a new connection on the next ask.
function pool(slots: Slot[]) {
  const destroyed: string[] = []
  let turn = 0
  const dial = (slot: Slot) => {
    const client = Object.assign(new EventEmitter(), {
      query: async () => {
        clock += slot.statementMs()
        return { rows: [], rowCount: 0 }
      },
      release: (destroy?: unknown) => {
        if (destroy) {
          destroyed.push(slot.name)
          const index = live.indexOf(client)
          slot = { name: `${slot.name}-redial`, statementMs: () => 3 }
          live[index] = dial(slot)
        }
      }
    })
    return client
  }
  const live = slots.map(dial)
  const fake = {
    totalCount: slots.length,
    idleCount: 0,
    waitingCount: 0,
    connect: async () => live[turn++ % live.length]
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: PostgresDatabase and its pool pressure read only connect, these counts and the optional options.
  const database = new PostgresDatabase(fake as never, undefined, { retiresSlowConnections: true })
  return { database, destroyed }
}

const steady = (ms: number) => () => ms

async function runStatements(database: PostgresDatabase, count: number): Promise<void> {
  for (let index = 0; index < count; index++) {
    await database.query('SELECT 1')
  }
}

describe('slow connection retirement', () => {
  beforeEach(() => {
    clock = 0
    vi.spyOn(performance, 'now').mockImplementation(() => clock)
    vi.spyOn(Date, 'now').mockImplementation(() => clock)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('retires one 55 ms connection among 3 ms peers', async () => {
    const slow = pool([
      { name: 'a', statementMs: steady(3) },
      { name: 'b', statementMs: steady(3) },
      { name: 'slow', statementMs: steady(55) }
    ])
    await runStatements(slow.database, SLOW_CONNECTION_WINDOW * 3)

    expect(slow.destroyed).toEqual(['slow'])
  })

  it('retires nothing when the whole database slows down', async () => {
    let slowDatabase = false
    const statementMs = () => (slowDatabase ? 60 : 3)
    const all = pool(['a', 'b', 'c'].map((name) => ({ name, statementMs })))
    await runStatements(all.database, SLOW_CONNECTION_WINDOW * 3)
    slowDatabase = true
    await runStatements(all.database, SLOW_CONNECTION_WINDOW * 6)

    expect(all.destroyed).toEqual([])
  })

  it('judges a transaction connection on release, never mid-transaction', async () => {
    const tx = pool([
      { name: 'a', statementMs: steady(3) },
      { name: 'slow', statementMs: steady(55) }
    ])
    // Each runs two short of a full window; one more turn leaves the next checkout on the slow one.
    await runStatements(tx.database, (SLOW_CONNECTION_WINDOW - 2) * 2 + 1)
    await tx.database.transaction(async (transaction) => {
      // BEGIN and this statement fill the window mid-transaction; nothing is judged until release.
      await transaction.query('SELECT 1')
      expect(tx.destroyed).toEqual([])
    })

    expect(tx.destroyed).toEqual(['slow'])
  })
})

import { describe, expect, it, vi } from 'vitest'
import { PostgresPoolPressure } from './postgres-pool-pressure.js'

describe('PostgreSQL pool pressure', () => {
  it('reports current waiters and interval high-water marks', async () => {
    let now = 1_000
    let resolveConnection!: (client: unknown) => void
    const connection = new Promise((resolve) => {
      resolveConnection = resolve
    })
    const pool = {
      totalCount: 3,
      idleCount: 0,
      waitingCount: 0,
      connect: vi.fn(() => {
        pool.waitingCount++
        return connection
      })
    }
    const pressure = new PostgresPoolPressure(pool as never, () => now)
    const pending = pressure.connect()
    now = 1_750

    expect(pressure.consumeCounts()).toMatchObject({
      databasePoolTotal: 3,
      databasePoolIdle: 0,
      databasePoolWaiting: 1,
      databasePoolWaitersMax: 1,
      databasePoolOldestWaitMs: 750,
      databasePoolWaitMsMax: 750
    })

    now = 2_250
    pool.waitingCount--
    resolveConnection({ query: vi.fn(), release: vi.fn() })
    await pending
    expect(pressure.consumeCounts()).toMatchObject({
      databasePoolWaiting: 0,
      databasePoolWaitersMax: 1,
      databasePoolOldestWaitMs: 0,
      databasePoolWaitMsMax: 1_250
    })
    expect(pressure.consumeCounts()).toMatchObject({
      databasePoolWaitersMax: 0,
      databasePoolWaitMsMax: 0
    })
  })
})

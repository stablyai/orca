import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { isPostgresPoolConnectTimeout, PostgresPoolPressure } from './postgres-pool-pressure.js'

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
    // An EventEmitter because the acquire path now attaches an `error` listener.
    resolveConnection(Object.assign(new EventEmitter(), { query: vi.fn(), release: vi.fn() }))
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

  it('reads the oldest wait as it is now, not the interval maximum', async () => {
    let now = 1_000
    const pool = {
      totalCount: 1,
      idleCount: 0,
      waitingCount: 0,
      connect: vi.fn(() => {
        pool.waitingCount++
        return new Promise(() => {})
      })
    }
    const pressure = new PostgresPoolPressure(pool as never, () => now)
    expect(pressure.oldestWaitMs()).toBe(0)
    void pressure.connect()
    now = 2_600
    expect(pressure.oldestWaitMs()).toBe(1_600)
  })
})

describe('PostgreSQL pool priority lane', () => {
  // pg-pool's acquire contract with a hand-driven supply of free connections.
  function controlledPool(max: number, connectionTimeoutMillis = 0) {
    const pending: Array<(client: unknown) => void> = []
    const pool = {
      options: { max, connectionTimeoutMillis },
      totalCount: 0,
      idleCount: 0,
      waitingCount: 0,
      connect: vi.fn(() => {
        if (pool.totalCount < max) {
          pool.totalCount++
          return Promise.resolve(client())
        }
        pool.waitingCount++
        return new Promise((resolve) => pending.push(resolve))
      })
    }
    const client = () =>
      Object.assign(new EventEmitter(), {
        query: vi.fn(),
        release: vi.fn(() => {
          const next = pending.shift()
          if (next) {
            pool.waitingCount--
            next(client())
          } else pool.totalCount--
        })
      })
    return pool
  }

  it('hands the next released connection to priority work ahead of queued general work', async () => {
    const pool = controlledPool(2)
    const pressure = new PostgresPoolPressure(pool as never)
    const general = [await pressure.connect(), await pressure.connect()]
    const order: string[] = []
    const queuedGeneral = pressure.connect().then((client) => {
      order.push('general')
      return client
    })
    const priority = pressure.connect('priority').then((client) => {
      order.push('priority')
      return client
    })
    await Promise.resolve()
    expect(pressure.peekCounts().databasePoolWaiting).toBe(2)

    general[0]!.release()
    const priorityClient = await priority
    expect(order).toEqual(['priority'])
    priorityClient.release()
    const generalClient = await queuedGeneral
    expect(order).toEqual(['priority', 'general'])
    for (const client of [general[1]!, generalClient]) client.release()
    expect(pool.totalCount).toBe(0)
    expect(pressure.peekCounts().databasePoolWaiting).toBe(0)
  })

  it('fails a queued general caller with the pool timeout every classifier knows', async () => {
    vi.useFakeTimers()
    try {
      const pressure = new PostgresPoolPressure(controlledPool(1, 2_000) as never)
      const held = await pressure.connect()
      const queued = pressure.connect().catch((error: unknown) => error)
      await vi.advanceTimersByTimeAsync(2_000)

      const error = await queued
      expect(isPostgresPoolConnectTimeout(error)).toBe(true)
      expect(pressure.peekCounts().databasePoolWaiting).toBe(0)
      // The timed-out caller left the queue, so the slot goes to the next one in line.
      held.release()
      const next = await pressure.connect()
      next.release()
    } finally {
      vi.useRealTimers()
    }
  })

})

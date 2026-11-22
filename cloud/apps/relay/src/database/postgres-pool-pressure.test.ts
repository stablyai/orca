import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { isPostgresPoolConnectTimeout, PostgresPoolPressure } from './postgres-pool-pressure.js'

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

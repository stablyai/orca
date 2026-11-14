import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { PostgresDatabase } from './database.js'

// Stands in for a pg client between acquire and release. pg-pool assigns
// `release` per checkout, which is the property the guard wraps.
class FakePoolClient extends EventEmitter {
  readonly released: Array<Error | boolean | undefined> = []

  constructor(private readonly respond: (sql: string) => { rows: unknown[]; rowCount: number }) {
    super()
  }

  query = vi.fn((sql: string) => {
    return Promise.resolve(this.respond(sql))
  })

  release = (error?: Error | boolean): void => {
    this.released.push(error)
  }
}

function poolOf(client: FakePoolClient) {
  return { totalCount: 1, idleCount: 0, waitingCount: 0, connect: async () => client }
}

describe('checked-out PostgreSQL client failure handling', () => {
  it('absorbs the error, rejects the transaction, and releases the client as failed', async () => {
    const terminated = Object.assign(new Error('Connection terminated unexpectedly'), {
      code: '57P01'
    })
    const client: FakePoolClient = new FakePoolClient((sql) => {
      if (sql !== 'SELECT 1') return { rows: [], rowCount: 0 }
      // Cloud SQL terminating the session: the client emits `error` and the
      // in-flight statement rejects with the same failure.
      expect(() => client.emit('error', terminated)).not.toThrow()
      throw terminated
    })
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const database = new PostgresDatabase(poolOf(client) as never)

      await expect(
        database.transaction(async (transaction) => await transaction.query('SELECT 1'))
      ).rejects.toBe(terminated)

      expect(client.released).toEqual([terminated])
    } finally {
      warning.mockRestore()
    }
  })

})

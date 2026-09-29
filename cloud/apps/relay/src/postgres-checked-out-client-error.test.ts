import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { PostgresDatabase } from './database.js'

// Stands in for a pg client between acquire and release. pg-pool assigns
// `release` per checkout, which is the property the guard wraps.
class FakePoolClient extends EventEmitter {
  readonly released: Array<Error | boolean | undefined> = []
  readonly statements: string[] = []

  constructor(private readonly respond: (sql: string) => { rows: unknown[]; rowCount: number }) {
    super()
  }

  query = vi.fn((sql: string) => {
    this.statements.push(sql)
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
  it('crashes the process when nothing listens, which is the bug being fixed', () => {
    // Node's own contract: this is what killed cell c28 on 2026-09-20 20:18Z.
    const unguarded = new EventEmitter()
    expect(() => unguarded.emit('error', new Error('Connection terminated unexpectedly'))).toThrow(
      'Connection terminated unexpectedly'
    )
  })

  it('absorbs the error, rejects the transaction, and releases the client as failed', async () => {
    const terminated = Object.assign(new Error('Connection terminated unexpectedly'), {
      code: '57P01'
    })
    let listenersWhileCheckedOut = 0
    const client: FakePoolClient = new FakePoolClient((sql) => {
      if (sql !== 'SELECT 1') return { rows: [], rowCount: 0 }
      listenersWhileCheckedOut = client.listenerCount('error')
      // Cloud SQL terminating the session: the client emits `error` and the
      // in-flight statement rejects with the same failure.
      expect(() => client.emit('error', terminated)).not.toThrow()
      throw terminated
    })
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const database = new PostgresDatabase(poolOf(client) as never)

    await expect(
      database.transaction(async (transaction) => await transaction.query('SELECT 1'))
    ).rejects.toBe(terminated)

    expect(listenersWhileCheckedOut).toBe(1)
    expect(client.listenerCount('error')).toBe(0)
    expect(client.released).toEqual([terminated])
    expect(client.statements).toEqual(['BEGIN', 'SELECT 1', 'ROLLBACK'])
    expect(warning).toHaveBeenCalledWith(
      '[orca-relay] checked-out PostgreSQL client failed: 57P01 Connection terminated unexpectedly'
    )

    warning.mockRestore()
  })

  it('releases a healthy client back to the pool with no error', async () => {
    const client = new FakePoolClient(() => ({ rows: [{ one: 1 }], rowCount: 1 }))
    const database = new PostgresDatabase(poolOf(client) as never)

    await expect(
      database.transaction(async (transaction) => await transaction.query('SELECT 1'))
    ).resolves.toEqual([{ one: 1 }])

    expect(client.released).toEqual([undefined])
    expect(client.listenerCount('error')).toBe(0)
  })
})

import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { isRelayDatabaseTransientError, PostgresDatabase } from './database.js'
import {
  isFencedRelayDatabaseRejection,
  POSTGRES_READ_TIMEOUT_MESSAGE
} from './relay-database-rejection-fence.js'

// pg's query_timeout firing: the statement's reply never arrived.
const readTimeout = () => new Error(POSTGRES_READ_TIMEOUT_MESSAGE)

class FakePoolClient extends EventEmitter {
  readonly statements: string[] = []
  readonly released: Array<Error | boolean | undefined> = []

  constructor(private readonly timesOut: (sql: string) => boolean) {
    super()
  }

  query = vi.fn(async (sql: string) => {
    this.statements.push(sql)
    if (this.timesOut(sql)) throw readTimeout()
    return { rows: [{ one: 1 }], rowCount: 1 }
  })

  release = (error?: Error | boolean): void => {
    this.released.push(error)
  }
}

function databaseOver(timesOut: (sql: string) => boolean) {
  const clients: FakePoolClient[] = []
  const database = new PostgresDatabase({
    totalCount: 1,
    idleCount: 0,
    waitingCount: 0,
    connect: async () => {
      const client = new FakePoolClient(timesOut)
      clients.push(client)
      return client
    }
  } as never)
  return { database, clients }
}

describe('a lost PostgreSQL reply', () => {
  it('ends a bounded locked statement with nothing else sent on its connection', async () => {
    const { database, clients } = databaseOver((sql) => sql.includes('FOR UPDATE'))
    const failure = await database
      .transaction(
        async (transaction) =>
          await transaction.queryLocked('SELECT id FROM cells WHERE id = ?', ['c1'], {
            lockTimeoutMs: 200
          })
      )
      .catch((error: unknown) => error)
    expect(failure).toEqual(readTimeout())
    // Not retried, no lock_timeout restore, no ROLLBACK, no COMMIT behind the dead statement.
    expect(clients).toHaveLength(1)
    expect(clients[0]?.statements).toEqual([
      'BEGIN',
      "SET LOCAL lock_timeout = '200ms'",
      'SELECT id FROM cells WHERE id = $1 FOR UPDATE'
    ])
    // Released with the error, so pg-pool destroys it instead of reusing it.
    expect(clients[0]?.released).toEqual([failure])
    // Answered 503 like a dropped connection, and survivable if nothing awaited it.
    expect(isRelayDatabaseTransientError(failure)).toBe(true)
    expect(isFencedRelayDatabaseRejection(failure)).toBe(true)
  })

  it('never commits after an operation that caught the timeout and carried on', async () => {
    const { database, clients } = databaseOver((sql) => sql === 'UPDATE cells SET n = n + 1')
    const failure = await database
      .transaction(async (transaction) => {
        await transaction.query('UPDATE cells SET n = n + 1').catch(() => undefined)
        // Every later statement on the poisoned transaction fails at once, unsent.
        await expect(transaction.query('SELECT 1')).rejects.toEqual(readTimeout())
        return 'carried on'
      })
      .catch((error: unknown) => error)
    expect(failure).toEqual(readTimeout())
    expect(clients[0]?.statements).toEqual(['BEGIN', 'UPDATE cells SET n = n + 1'])
    expect(clients[0]?.released).toEqual([failure])
  })

  it('treats a lost COMMIT reply as an unknown outcome: no ROLLBACK, no retry', async () => {
    const { database, clients } = databaseOver((sql) => sql === 'COMMIT')
    await expect(
      database.transaction(async (transaction) => await transaction.query('SELECT 1'))
    ).rejects.toEqual(readTimeout())
    expect(clients).toHaveLength(1)
    expect(clients[0]?.statements).toEqual(['BEGIN', 'SELECT 1', 'COMMIT'])
    expect(clients[0]?.released[0]).toEqual(readTimeout())
  })

  it('destroys the client of a timed-out autocommit statement and serves the next one', async () => {
    let first = true
    const { database, clients } = databaseOver(() => {
      const timesOut = first
      first = false
      return timesOut
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(database.query('SELECT 1')).rejects.toEqual(readTimeout())
    await expect(database.query('SELECT 1')).resolves.toEqual([{ one: 1 }])
    expect(clients.map((client) => client.released)).toEqual([[readTimeout()], [undefined]])
  })

  it('still rolls back and retries an ordinary server error', async () => {
    let failures = 1
    const { database, clients } = databaseOver(() => false)
    const result = await database.transaction(async (transaction) => {
      if (failures-- > 0) throw Object.assign(new Error('deadlock detected'), { code: '40P01' })
      return await transaction.query('SELECT 1')
    })
    expect(result).toEqual([{ one: 1 }])
    expect(clients.map((client) => client.statements)).toEqual([
      ['BEGIN', 'ROLLBACK'],
      ['BEGIN', 'SELECT 1', 'COMMIT']
    ])
    expect(clients.map((client) => client.released)).toEqual([[undefined], [undefined]])
  })
})

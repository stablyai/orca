import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PostgresDatabase } from './database.js'
import { POSTGRES_READ_TIMEOUT_MESSAGE } from './relay-database-rejection-fence.js'

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
  afterEach(() => vi.restoreAllMocks())

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

})

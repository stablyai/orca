import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PostgresDatabase } from './database.js'

// One client whose statements after BEGIN fail as given; records each statement and release.
function failingPool(failure: () => Error) {
  const releases: unknown[] = []
  const statements: string[] = []
  const client = Object.assign(new EventEmitter(), {
    query: async (sql: string) => {
      statements.push(sql)
      if (sql === 'BEGIN') return { rows: [], rowCount: null }
      throw failure()
    },
    release: (error?: unknown) => void releases.push(error)
  })
  const pool = { totalCount: 1, idleCount: 0, waitingCount: 0, connect: async () => client }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: PostgresDatabase and its pool pressure read only connect, these counts and the optional options.
  return { database: new PostgresDatabase(pool as never), releases, statements }
}

const withCode = (code: string) => () => Object.assign(new Error('server error'), { code })

describe('PostgreSQL session end', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it.each([
    ['57P01', withCode('57P01')],
    ['57P05', withCode('57P05')],
    ['08006', withCode('08006')],
    ['Connection terminated', () => new Error('Connection terminated unexpectedly')]
  ])('destroys a client after %s, so no caller inherits it', async (_name, failure) => {
    const query = failingPool(failure)
    await expect(query.database.query('SELECT 1')).rejects.toThrow()
    expect(query.releases).toEqual([expect.any(Error)])

    const transaction = failingPool(failure)
    await expect(
      transaction.database.transaction(async (tx) => await tx.query('SELECT 1'))
    ).rejects.toThrow()
    expect(transaction.releases).toEqual([expect.any(Error)])
    expect(transaction.statements).not.toContain('ROLLBACK')
  })

  it('returns a client to the pool after an ordinary statement error', async () => {
    const query = failingPool(withCode('23505'))
    await expect(query.database.query('SELECT 1')).rejects.toMatchObject({ code: '23505' })
    expect(query.releases).toEqual([undefined])

    const transaction = failingPool(withCode('23505'))
    await expect(
      transaction.database.transaction(async (tx) => await tx.query('SELECT 1'))
    ).rejects.toMatchObject({ code: '23505' })
    expect(transaction.releases).toEqual([undefined])
    expect(transaction.statements).toContain('ROLLBACK')
  })
})

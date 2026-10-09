import { EventEmitter } from 'node:events'
import pg from 'pg'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { keepPostgresClientErrorsHandled, PostgresDatabase } from './database.js'
import {
  handleRelayUnhandledRejection,
  isFencedRelayDatabaseRejection
} from './relay-database-rejection-fence.js'

class FakePoolClient extends EventEmitter {
  constructor(private readonly respond: (sql: string) => unknown) {
    super()
  }

  query = vi.fn(async (sql: string) => this.respond(sql))
  release = (): void => {}
}

function databaseFailingWith(failure: unknown, failOn = 'SELECT 1'): PostgresDatabase {
  const client = new FakePoolClient((sql) => {
    if (sql === failOn) throw failure
    return { rows: [], rowCount: 0 }
  })
  return new PostgresDatabase({
    totalCount: 1,
    idleCount: 0,
    waitingCount: 0,
    connect: async () => client
  } as never)
}

function databaseFailingToConnect(failure: unknown): PostgresDatabase {
  return new PostgresDatabase({
    totalCount: 0,
    idleCount: 0,
    waitingCount: 1,
    connect: async () => {
      throw failure
    }
  } as never)
}

function serverError(code: string, message: string): pg.DatabaseError {
  const error = new pg.DatabaseError(message, message.length, 'error')
  error.code = code
  return error
}

// What reaches unhandledRejection when a caller forgets to await the database.
async function rejectionFrom(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run()
  } catch (error) {
    return error
  }
  throw new Error('expected a rejection')
}

describe('database rejection fence', () => {
  let warn: MockInstance<typeof console.warn>
  let error: MockInstance<typeof console.error>
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    error = vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    warn.mockRestore()
    error.mockRestore()
  })

  it('fences a constraint violation and a dropped connection from the database layer', async () => {
    const duplicate = await rejectionFrom(() =>
      databaseFailingWith(serverError('23505', 'duplicate key')).query('SELECT 1')
    )
    expect(() => handleRelayUnhandledRejection(duplicate)).not.toThrow()
    const terminated = await rejectionFrom(() =>
      databaseFailingWith(new Error('Connection terminated unexpectedly')).transaction(
        async (transaction) => await transaction.query('SELECT 1')
      )
    )
    expect(() => handleRelayUnhandledRejection(terminated)).not.toThrow()
    const fenced = warn.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.includes('"event":"orca_relay_database_rejection_fenced"'))
    expect(fenced).toHaveLength(2)
    expect(fenced[0]).toContain('"code":"23505"')
    expect(error).not.toHaveBeenCalled()
  })

  // A whole-VM stall of 6-7 s outlasts the 5 s idle-in-transaction limit for any backend caught
  // idle mid-transaction, and the server ends that session with FATAL 25P03 on resume.
  it('fences an idle-in-transaction timeout but keeps the rest of class 25 fatal', async () => {
    const idleTimeout = await rejectionFrom(() =>
      databaseFailingWith(
        serverError('25P03', 'terminating connection due to idle-in-transaction timeout')
      ).transaction(async (transaction) => await transaction.query('SELECT 1'))
    )
    expect(isFencedRelayDatabaseRejection(idleTimeout)).toBe(true)
    const abortedTransaction = await rejectionFrom(() =>
      databaseFailingWith(
        serverError('25P02', 'current transaction is aborted, commands ignored')
      ).query('SELECT 1')
    )
    expect(isFencedRelayDatabaseRejection(abortedTransaction)).toBe(false)
  })

  it('fences every failure to get a pooled client, including bad credentials', async () => {
    const badPassword = serverError('28P01', 'password authentication failed')
    const failure = await rejectionFrom(() =>
      databaseFailingToConnect(badPassword).transaction(async () => undefined)
    )
    expect(failure).toBe(badPassword)
    expect(isFencedRelayDatabaseRejection(failure)).toBe(true)
  })

  it('keeps schema errors, pg TypeErrors and a lock-unavailable answer fatal', async () => {
    const missingTable = await rejectionFrom(() =>
      databaseFailingWith(serverError('42P01', 'relation does not exist')).query('SELECT 1')
    )
    const serialisation = await rejectionFrom(() =>
      databaseFailingWith(new TypeError('Cannot convert a BigInt value')).query('SELECT 1')
    )
    const lockUnavailable = await rejectionFrom(() =>
      databaseFailingWith(serverError('55P03', 'could not obtain lock'), 'SELECT 1 FOR UPDATE NOWAIT')
        .transaction(async (transaction) =>
          await transaction.queryLocked('SELECT 1', [], { failIfUnavailable: true })
        )
    )
    expect(lockUnavailable).toEqual(new Error('database_lock_unavailable'))
    for (const reason of [missingTable, serialisation, lockUnavailable]) {
      expect(() => handleRelayUnhandledRejection(reason)).toThrow()
    }
    expect(error.mock.calls.map((call) => String(call[0]))).toEqual([
      expect.stringContaining('"event":"orca_relay_process_fatal"'),
      expect.stringContaining('"event":"orca_relay_process_fatal"'),
      expect.stringContaining('"event":"orca_relay_process_fatal"')
    ])
  })

  it('fences a socket reset or broken pipe thrown mid-statement', async () => {
    for (const code of ['ECONNRESET', 'EPIPE']) {
      const dropped = Object.assign(new Error(`read ${code}`), { code })
      const reason = await rejectionFrom(() =>
        databaseFailingWith(dropped).transaction(
          async (transaction) => await transaction.query('SELECT 1')
        )
      )
      expect(reason).toBe(dropped)
      expect(() => handleRelayUnhandledRejection(reason)).not.toThrow()
    }
    expect(error).not.toHaveBeenCalled()
  })

  it('keeps a database-looking error fatal when the database layer never saw it', () => {
    const socketReset = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })
    const unmarked = serverError('23505', 'duplicate key')
    const terminated = new Error('Connection terminated unexpectedly')
    for (const reason of [socketReset, unmarked, terminated, undefined, 'text']) {
      expect(isFencedRelayDatabaseRejection(reason)).toBe(false)
    }
    expect(() => handleRelayUnhandledRejection(socketReset)).toThrow(socketReset)
  })
})

describe('permanent PostgreSQL client error listener', () => {
  it('leaves every client with a listener for its whole life', () => {
    const pool = new EventEmitter()
    keepPostgresClientErrorsHandled(pool as never)
    const client = new EventEmitter()
    pool.emit('connect', client)
    expect(() => client.emit('error', new Error('Connection terminated unexpectedly'))).not.toThrow()
  })
})

import { describe, expect, it, vi } from 'vitest'
import { isRelayDatabaseTransientError, PostgresDatabase } from './database.js'
import { PostgresPoolPressure } from './postgres-pool-pressure.js'

// The only way to mark an error as an acquire failure is to fail a real
// acquire, so the gated cases go through the pressure wrapper the pool uses.
async function failedAcquire(message: string): Promise<unknown> {
  const pool = {
    totalCount: 0,
    idleCount: 0,
    waitingCount: 0,
    connect: vi.fn(async () => {
      throw new Error(message)
    })
  }
  return await new PostgresPoolPressure(pool as never).connect().catch((error: unknown) => error)
}

async function failedQuery(failure: Error): Promise<unknown> {
  const client = {
    query: vi.fn(async () => {
      throw failure
    }),
    release: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn()
  }
  const database = new PostgresDatabase({
    totalCount: 1,
    idleCount: 0,
    waitingCount: 0,
    connect: async () => client
  } as never)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  return await database.query('SELECT 1').catch((error: unknown) => error)
}

describe('relay database transient errors', () => {
  it.each([
    '40P01',
    '40001',
    '55P03',
    '57014',
    '53300',
    '57P01',
    '57P02',
    '57P03',
    '08000',
    '08001',
    '08003',
    '08006',
    '25P03'
  ])(
    'classifies PostgreSQL code %s as retryable overload',
    (code) => {
      expect(isRelayDatabaseTransientError({ code })).toBe(true)
    }
  )

  it('classifies pool acquisition timeout without hiding programming failures', () => {
    expect(
      isRelayDatabaseTransientError(new Error('timeout exceeded when trying to connect'))
    ).toBe(true)
    expect(isRelayDatabaseTransientError(new TypeError('broken invariant'))).toBe(false)
  })

  it('classifies a pool connect timeout that node-postgres reports with no code', () => {
    // pg-pool raises this only from its own connect path, so no statement ran.
    expect(
      isRelayDatabaseTransientError(
        new Error('Connection terminated due to connection timeout')
      )
    ).toBe(true)
  })

  it('classifies an early-ended socket during the acquire', async () => {
    expect(
      isRelayDatabaseTransientError(await failedAcquire('Connection terminated unexpectedly'))
    ).toBe(true)
  })

  // Staging B1: pg_terminate_backend mid-request answered /v1/assign with 500. A dropped
  // connection is 503 + Retry-After, as 08006 always was; transaction() still never retries it,
  // since the commit outcome is unknown.
  it('classifies a connection dropped mid-statement, but only from the database layer', async () => {
    const failures = [
      (): Error => new Error('Connection terminated unexpectedly'),
      (): Error => Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })
    ]
    for (const failure of failures) {
      expect(isRelayDatabaseTransientError(await failedQuery(failure()))).toBe(true)
      // The same errno or message from any other socket is not a database answer.
      expect(isRelayDatabaseTransientError(failure())).toBe(false)
    }
  })

  it.each([null, undefined, 'a thrown string'])(
    'survives %s reaching it instead of an error object',
    (thrown) => {
      expect(isRelayDatabaseTransientError(thrown)).toBe(false)
    }
  )

  it('keeps a failed acquire that is not transient out of the retry path', async () => {
    expect(
      isRelayDatabaseTransientError(
        await failedAcquire('password authentication failed for user "relay"')
      )
    ).toBe(false)
  })
})

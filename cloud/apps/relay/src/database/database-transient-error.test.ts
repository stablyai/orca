import { describe, expect, it, vi } from 'vitest'
import { isRelayDatabaseTransientError, PostgresDatabase } from './database.js'
import { PostgresPoolPressure } from './postgres-pool-pressure.js'

// The only way to mark an error as an acquire failure is to fail a real
// acquire, so the gated cases go through the pressure wrapper the pool uses.
async function failedAcquire(failure: string | Error): Promise<unknown> {
  const pool = {
    totalCount: 0,
    idleCount: 0,
    waitingCount: 0,
    connect: vi.fn(async () => {
      throw typeof failure === 'string' ? new Error(failure) : failure
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

  // Staging B1 re-test: a Cloud SQL restart failed the transaction's acquire with `write EPIPE`.
  it('classifies an acquire EPIPE only from the database layer', async () => {
    const failure = (): Error => Object.assign(new Error('connect EPIPE'), { code: 'EPIPE' })
    expect(isRelayDatabaseTransientError(await failedAcquire(failure()))).toBe(true)
    expect(isRelayDatabaseTransientError(failure())).toBe(false)
  })

  // Database-layer drops answer 503/Retry-After (staging B1); never retry transaction work with unknown commit outcome.
  it('classifies a mid-statement drop only from the database layer', async () => {
    const failures = [
      (): Error => new Error('Connection terminated unexpectedly'),
      (): Error => Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
      (): Error => Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })
    ]
    for (const failure of failures) {
      expect(isRelayDatabaseTransientError(await failedQuery(failure()))).toBe(true)
      // The same errno or message from any other socket is not a database answer.
      expect(isRelayDatabaseTransientError(failure())).toBe(false)
    }
  })

})

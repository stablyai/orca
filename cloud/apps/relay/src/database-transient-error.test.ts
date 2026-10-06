import { describe, expect, it, vi } from 'vitest'
import { isRelayDatabaseTransientError } from './database.js'
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

describe('relay database transient errors', () => {
  it.each(['40P01', '40001', '55P03', '57014', '53300', '57P03', '08001', '08006'])(
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

  it('classifies an early-ended socket only when it ended during the acquire', async () => {
    expect(
      isRelayDatabaseTransientError(await failedAcquire('Connection terminated unexpectedly'))
    ).toBe(true)
    // The same message mid-statement leaves the commit outcome unknown, so it
    // must stay a hard failure rather than invite a retry.
    expect(
      isRelayDatabaseTransientError(new Error('Connection terminated unexpectedly'))
    ).toBe(false)
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

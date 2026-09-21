import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fakes = vi.hoisted(() => ({
  connectError: undefined as unknown,
  query: vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [], rowCount: 0 })),
  release: vi.fn()
}))

vi.mock('pg', () => ({
  default: {
    Pool: class {
      totalCount = 10
      idleCount = 0
      waitingCount = 7
      on = vi.fn()
      async connect() {
        if (fakes.connectError) throw fakes.connectError
        return { query: fakes.query, release: fakes.release }
      }
      async end() {}
    }
  }
}))

import { openRelayDatabase, type RelayDatabase } from './database.js'

describe('PostgreSQL query failure diagnostics', () => {
  let database: RelayDatabase
  const sql = 'WITH assignment_state AS MATERIALIZED (SELECT $1) SELECT * FROM assignment_state'

  beforeEach(async () => {
    fakes.connectError = undefined
    fakes.query.mockReset().mockResolvedValue({ rows: [], rowCount: 0 })
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    database = await openRelayDatabase({ databaseUrl: 'postgres://unused', dataDir: '' })
    fakes.query.mockClear()
    fakes.release.mockClear()
    vi.mocked(console.warn).mockClear()
  })

  afterEach(async () => {
    await database.close()
    vi.restoreAllMocks()
  })

  it('identifies acquisition failure without issuing SQL or changing the error', async () => {
    const error = new Error('timeout exceeded when trying to connect: private detail')
    fakes.connectError = error
    await expect(database.query(sql, ['private-token'])).rejects.toBe(error)
    expect(fakes.query).not.toHaveBeenCalled()
    expect(fakes.release).not.toHaveBeenCalled()
    expect(JSON.parse(vi.mocked(console.warn).mock.calls[0]![0] as string)).toEqual({
      event: 'orca_relay_postgres_query_failed',
      phase: 'acquire',
      operation: 'control-renewal',
      code: 'unknown',
      connectionTimeout: true,
      elapsedMs: expect.any(Number),
      poolTotal: 10,
      poolIdle: 0,
      poolWaiting: 7
    })
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain('private')
  })

  it.each(['57014', '55P03', 'ECONNRESET'])(
    'identifies execute failure %s and releases its client',
    async (code) => {
      const error = Object.assign(new Error('private-token'), { code, detail: sql })
      fakes.query.mockRejectedValueOnce(error)
      await expect(database.query(sql, ['private-token'])).rejects.toBe(error)
      expect(fakes.query).toHaveBeenCalledOnce()
      expect(fakes.release).toHaveBeenCalledOnce()
      expect(JSON.parse(vi.mocked(console.warn).mock.calls[0]![0] as string)).toMatchObject({
        phase: 'execute',
        operation: 'control-renewal',
        code,
        connectionTimeout: false
      })
      expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain('private-token')
      expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain(sql)
    }
  )

  it('does not emit an arbitrary error code, message, query, or parameter', async () => {
    const error = { code: 'private-code', message: 'private-message' }
    fakes.query.mockRejectedValueOnce(error)
    await expect(database.query('SELECT private_column', ['private-param'])).rejects.toBe(error)
    const log = vi.mocked(console.warn).mock.calls[0]![0] as string
    expect(JSON.parse(log)).toMatchObject({ operation: 'other', code: 'unknown' })
    expect(log).not.toContain('private')
  })

  it('keeps the original error and releases the client if logging fails', async () => {
    const error = new Error('database failure')
    fakes.query.mockRejectedValueOnce(error)
    vi.mocked(console.warn).mockImplementationOnce(() => {
      throw new Error('logger failure')
    })
    await expect(database.query(sql)).rejects.toBe(error)
    expect(fakes.release).toHaveBeenCalledOnce()
  })

  it('does not log successful queries', async () => {
    await database.query(sql)
    expect(console.warn).not.toHaveBeenCalled()
    expect(fakes.release).toHaveBeenCalledOnce()
  })
})

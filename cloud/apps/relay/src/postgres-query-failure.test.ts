import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fakes = vi.hoisted(() => ({
  connectError: undefined as unknown,
  query: vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [], rowCount: 0 })),
  release: vi.fn(),
  // A real pooled client is an EventEmitter, and the acquire path attaches an
  // `error` listener to it before handing it to the caller.
  client: () => ({
    query: fakes.query,
    release: fakes.release,
    on: vi.fn(),
    removeListener: vi.fn()
  })
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
        return fakes.client()
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
      transient: true,
      elapsedMs: expect.any(Number),
      poolTotal: 10,
      poolIdle: 0,
      poolWaiting: 7
    })
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain('private')
  })

  // ECONNRESET carries no SQLSTATE the routes retry on, and it arrives after the
  // statement went out, so it stays a hard failure. The pair pins that boundary.
  it.each([
    ['57014', true],
    ['55P03', true],
    ['ECONNRESET', false]
  ] as const)(
    'identifies execute failure %s and releases its client',
    async (code, transient) => {
      const error = Object.assign(new Error('private-token'), { code, detail: sql })
      fakes.query.mockRejectedValueOnce(error)
      await expect(database.query(sql, ['private-token'])).rejects.toBe(error)
      expect(fakes.query).toHaveBeenCalledOnce()
      expect(fakes.release).toHaveBeenCalledOnce()
      expect(JSON.parse(vi.mocked(console.warn).mock.calls[0]![0] as string)).toMatchObject({
        phase: 'execute',
        operation: 'control-renewal',
        code,
        connectionTimeout: false,
        transient
      })
      expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain('private-token')
      expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain(sql)
    }
  )

  it('marks a dialling timeout that node-postgres reports with no code', async () => {
    // pg-pool raises this when a new client's own handshake outruns the limit.
    const error = new Error('Connection terminated due to connection timeout')
    fakes.connectError = error
    await expect(database.query(sql)).rejects.toBe(error)
    expect(JSON.parse(vi.mocked(console.warn).mock.calls[0]![0] as string)).toMatchObject({
      phase: 'acquire',
      code: 'unknown',
      connectionTimeout: true,
      transient: true
    })
  })

  it('separates an early-ended socket from a timeout while still calling it transient', async () => {
    const error = new Error('Connection terminated unexpectedly')
    fakes.connectError = error
    await expect(database.query(sql)).rejects.toBe(error)
    expect(JSON.parse(vi.mocked(console.warn).mock.calls[0]![0] as string)).toMatchObject({
      phase: 'acquire',
      code: 'unknown',
      connectionTimeout: false,
      transient: true
    })
  })

  it('reports an acquire failure that is not transient as a hard failure', async () => {
    const error = new Error('password authentication failed')
    fakes.connectError = error
    await expect(database.query(sql)).rejects.toBe(error)
    expect(JSON.parse(vi.mocked(console.warn).mock.calls[0]![0] as string)).toMatchObject({
      phase: 'acquire',
      connectionTimeout: false,
      transient: false
    })
  })

  it('does not emit an arbitrary error code, message, query, or parameter', async () => {
    const error = { code: 'private-code', message: 'private-message' }
    fakes.query.mockRejectedValueOnce(error)
    await expect(database.query('SELECT private_column', ['private-param'])).rejects.toBe(error)
    const log = vi.mocked(console.warn).mock.calls[0]![0] as string
    expect(JSON.parse(log)).toMatchObject({
      operation: 'other',
      code: 'unknown',
      transient: false
    })
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

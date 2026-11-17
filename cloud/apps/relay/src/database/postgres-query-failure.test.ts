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

  // A reset from the database layer answers 503 like 08006 (staging B1); transaction() still
  // never retries it, since the statement went out.

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

})

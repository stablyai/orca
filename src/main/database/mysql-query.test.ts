import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type { QueryOptions } from '../../shared/database-types'
import { cancelMysqlQuery, runMysqlQuery } from './mysql-query'

// Fake core query object: fires 'fields' when the stream starts, then streams
// each row as a chunk (object mode).
function makeCoreQuery(rows: unknown[][], fields: { name: string }[]) {
  const listeners: Record<string, (arg: unknown) => void> = {}
  return {
    on(event: string, cb: (arg: unknown) => void) {
      listeners[event] = cb
      return this
    },
    stream() {
      listeners.fields?.(fields as unknown)
      return Readable.from(rows)
    }
  }
}

function makeConnection(rows: unknown[][], fields: { name: string }[]) {
  const calls: string[] = []
  const core = { query: vi.fn(() => makeCoreQuery(rows, fields)) }
  const conn = {
    query: vi.fn((arg: string | { sql: string }) => {
      if (typeof arg === 'string') {
        calls.push(arg)
        if (arg.includes('CONNECTION_ID')) {
          return Promise.resolve([[{ id: 55 }], []])
        }
        return Promise.resolve([[], []])
      }
      calls.push(arg.sql)
      return Promise.resolve([{ affectedRows: 3 }, []])
    }),
    connection: core,
    release: vi.fn(),
    destroy: vi.fn()
  }
  return { calls, core, conn }
}

function makePool(conn: unknown) {
  return { getConnection: vi.fn(async () => conn) } as never
}

function opts(overrides: Partial<QueryOptions> = {}): QueryOptions {
  return { rowLimit: 2, timeoutMs: 30_000, allowWrite: false, ...overrides }
}

describe('runMysqlQuery', () => {
  it('streams a read in a read-only transaction and bounds the row count', async () => {
    const { calls, core, conn } = makeConnection([[1], [2], [3]], [{ name: 'n' }])
    const onStart = vi.fn()
    const result = await runMysqlQuery(makePool(conn), 'c1', 'SELECT * FROM t', opts(), onStart)

    expect(calls).toContain('START TRANSACTION READ ONLY')
    expect(calls).toContain('SET SESSION max_execution_time = 30000')
    expect(calls).toContain('COMMIT')
    // The user's SQL streams verbatim — no appended LIMIT.
    expect(core.query).toHaveBeenCalledWith({ sql: 'SELECT * FROM t', rowsAsArray: true })
    expect(result.rows).toEqual([[1], [2]])
    expect(result.truncated).toBe(true)
    expect(onStart).toHaveBeenCalledWith({ connectionId: 'c1', backendPid: 55 })
    // A truncated stream poisons the connection → dropped, not returned to the pool.
    expect(conn.destroy).toHaveBeenCalledTimes(1)
    expect(conn.release).not.toHaveBeenCalled()
  })

  it('returns all rows and releases the connection when under the cap', async () => {
    const { conn } = makeConnection([[1], [2]], [{ name: 'n' }])
    const result = await runMysqlQuery(makePool(conn), 'c1', 'SELECT * FROM t', opts({ rowLimit: 5 }), vi.fn())
    expect(result.truncated).toBe(false)
    expect(result.rows).toEqual([[1], [2]])
    expect(conn.release).toHaveBeenCalledTimes(1)
    expect(conn.destroy).not.toHaveBeenCalled()
  })

  it('runs a write directly under a plain transaction (no read-only, no stream)', async () => {
    const { calls, core, conn } = makeConnection([], [])
    const result = await runMysqlQuery(
      makePool(conn),
      'c1',
      'INSERT INTO t VALUES (1)',
      opts({ allowWrite: true }),
      vi.fn()
    )
    expect(calls).toContain('START TRANSACTION')
    expect(calls).not.toContain('START TRANSACTION READ ONLY')
    expect(core.query).not.toHaveBeenCalled()
    expect(result.rowCount).toBe(3)
  })
})

describe('cancelMysqlQuery', () => {
  it('issues KILL QUERY with the captured thread id and closes the session', async () => {
    const query = vi.fn().mockResolvedValue([[], []])
    const end = vi.fn().mockResolvedValue(undefined)
    await cancelMysqlQuery({ query, end } as never, 77)
    expect(query).toHaveBeenCalledWith('KILL QUERY 77')
    expect(end).toHaveBeenCalledTimes(1)
  })
})

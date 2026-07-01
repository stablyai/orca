import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type { QueryOptions } from '../../shared/database-types'
import { DbBatchError } from './db-driver'
import { cancelMysqlQuery, runMysqlBatch, runMysqlExecute, runMysqlQuery } from './mysql-query'

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

function makeConnection(
  rows: unknown[][],
  fields: { name: string }[],
  options: { commitRejects?: boolean } = {}
) {
  const calls: string[] = []
  const core = { query: vi.fn(() => makeCoreQuery(rows, fields)) }
  const conn = {
    query: vi.fn((arg: string | { sql: string }): Promise<[unknown, unknown]> => {
      if (typeof arg === 'string') {
        calls.push(arg)
        if (arg === 'COMMIT' && options.commitRejects) {
          return Promise.reject(new Error('commands out of sync'))
        }
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
    // H2: COMMIT must NOT run on a poisoned (early-torn-down) stream connection.
    expect(calls).not.toContain('COMMIT')
    // The user's SQL streams verbatim — no appended LIMIT.
    expect(core.query).toHaveBeenCalledWith({ sql: 'SELECT * FROM t', rowsAsArray: true })
    expect(result.rows).toEqual([[1], [2]])
    expect(result.truncated).toBe(true)
    expect(onStart).toHaveBeenCalledWith({ connectionId: 'c1', backendPid: 55 })
    // A truncated stream poisons the connection → dropped, not returned to the pool.
    expect(conn.destroy).toHaveBeenCalledTimes(1)
    expect(conn.release).not.toHaveBeenCalled()
  })

  it('does not lose truncated rows even if COMMIT would fail (H2)', async () => {
    // If COMMIT were issued on the poisoned connection it would reject; the fix
    // skips it, so the valid truncated rows still come back.
    const { conn } = makeConnection([[1], [2], [3]], [{ name: 'n' }], { commitRejects: true })
    const result = await runMysqlQuery(makePool(conn), 'c1', 'SELECT * FROM t', opts(), vi.fn())
    expect(result.rows).toEqual([[1], [2]])
    expect(result.truncated).toBe(true)
    expect(conn.destroy).toHaveBeenCalledTimes(1)
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

// Fake connection for the parameterized execute/batch paths: SELECT → rows,
// other DML → an affectedRows header. Records SQL + bind values per call.
function makeParamConnection(selectRows: unknown[][], fields: { name: string }[]) {
  const calls: { sql: string; values?: unknown[] }[] = []
  // Core (callback) connection used by the bounded streaming read path.
  const core = {
    query: vi.fn((arg: { sql: string; values?: unknown[]; rowsAsArray: boolean }) => {
      calls.push({ sql: arg.sql, values: arg.values })
      return makeCoreQuery(selectRows, fields)
    })
  }
  const conn = {
    query: vi.fn((arg: string | { sql: string; values?: unknown[] }): Promise<[unknown, unknown]> => {
      if (typeof arg === 'string') {
        calls.push({ sql: arg })
        if (arg.includes('CONNECTION_ID')) {
          return Promise.resolve([[{ id: 55 }], []])
        }
        return Promise.resolve([[], []])
      }
      // Non-cursorable statements (writes/DDL) run directly and return a header.
      calls.push({ sql: arg.sql, values: arg.values })
      return Promise.resolve([{ affectedRows: 2 }, []])
    }),
    connection: core,
    release: vi.fn(),
    destroy: vi.fn()
  }
  return { calls, conn }
}

describe('runMysqlExecute', () => {
  it('runs a read in a read-only transaction, threads params, and commits', async () => {
    const { calls, conn } = makeParamConnection([[1], [2]], [{ name: 'n' }])
    const result = await runMysqlExecute(
      makePool(conn),
      'c1',
      { sql: 'SELECT * FROM t WHERE a = ? LIMIT 100 OFFSET 0', params: [9] },
      opts({ rowLimit: 1000 }),
      vi.fn()
    )
    const sqls = calls.map((c) => c.sql)
    expect(sqls).toContain('START TRANSACTION READ ONLY')
    expect(sqls).toContain('COMMIT')
    const select = calls.find((c) => c.sql.startsWith('SELECT * FROM t'))
    expect(select?.values).toEqual([9])
    expect(result.rows).toEqual([[1], [2]])
    expect(result.columns).toEqual([{ name: 'n' }])
    expect(conn.release).toHaveBeenCalledTimes(1)
  })

  it('uses a plain (writable) transaction when allowWrite', async () => {
    const { calls, conn } = makeParamConnection([], [])
    await runMysqlExecute(
      makePool(conn),
      'c1',
      { sql: 'UPDATE t SET a = ? WHERE id = ?', params: [1, 2] },
      opts({ allowWrite: true }),
      vi.fn()
    )
    const sqls = calls.map((c) => c.sql)
    expect(sqls).toContain('START TRANSACTION')
    expect(sqls).not.toContain('START TRANSACTION READ ONLY')
    expect(sqls).toContain('COMMIT')
  })

  it('bounds a streamed read to rowLimit and drops the poisoned connection', async () => {
    const { conn } = makeParamConnection([[1], [2], [3]], [{ name: 'n' }])
    const result = await runMysqlExecute(
      makePool(conn),
      'c1',
      { sql: 'SELECT * FROM t', params: [] },
      opts({ rowLimit: 2 }),
      vi.fn()
    )
    expect(result.rows).toEqual([[1], [2]])
    expect(result.truncated).toBe(true)
    expect(conn.destroy).toHaveBeenCalledTimes(1)
  })
})

describe('runMysqlBatch', () => {
  it('applies every statement in one transaction and returns affectedRows per statement', async () => {
    const { calls, conn } = makeParamConnection([], [])
    const counts = await runMysqlBatch(
      makePool(conn),
      'c1',
      [
        { sql: 'UPDATE t SET a = ? WHERE id = ?', params: [1, 10] },
        { sql: 'DELETE FROM t WHERE id = ?', params: [11] }
      ],
      opts({ allowWrite: true }),
      vi.fn()
    )
    const sqls = calls.map((c) => c.sql)
    expect(sqls).toContain('START TRANSACTION')
    expect(sqls).toContain('COMMIT')
    expect(sqls).not.toContain('ROLLBACK')
    expect(counts).toEqual([2, 2])
  })

  it('uses a read-only transaction when allowWrite is false', async () => {
    const { calls, conn } = makeParamConnection([], [])
    await runMysqlBatch(
      makePool(conn),
      'c1',
      [{ sql: 'UPDATE t SET a = ? WHERE id = ?', params: [1, 2] }],
      opts({ allowWrite: false }),
      vi.fn()
    )
    expect(calls.map((c) => c.sql)).toContain('START TRANSACTION READ ONLY')
  })

  it('rolls back and throws DbBatchError with the failing index', async () => {
    const calls: string[] = []
    const conn = {
      query: vi.fn((arg: string | { sql: string; values?: unknown[] }): Promise<[unknown, unknown]> => {
        const sql = typeof arg === 'string' ? arg : arg.sql
        calls.push(sql)
        if (sql.includes('CONNECTION_ID')) {
          return Promise.resolve([[{ id: 55 }], []])
        }
        if (sql.startsWith('DELETE')) {
          return Promise.reject(Object.assign(new Error('fk'), { code: 'ER_ROW_IS_REFERENCED' }))
        }
        return Promise.resolve([{ affectedRows: 1 }, []])
      }),
      release: vi.fn(),
      destroy: vi.fn()
    }
    const err = await runMysqlBatch(
      makePool(conn),
      'c1',
      [
        { sql: 'UPDATE t SET a = ? WHERE id = ?', params: [1, 10] },
        { sql: 'DELETE FROM t WHERE id = ?', params: [11] }
      ],
      opts({ allowWrite: true }),
      vi.fn()
    ).catch((e) => e)
    expect(err).toBeInstanceOf(DbBatchError)
    expect((err as DbBatchError).failedIndex).toBe(1)
    expect(calls).toContain('ROLLBACK')
    expect(calls).not.toContain('COMMIT')
    expect(conn.release).toHaveBeenCalledTimes(1)
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

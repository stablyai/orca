import { describe, expect, it, vi } from 'vitest'
import type { QueryOptions } from '../../shared/database-types'
import { DbBatchError } from './db-driver'
import {
  cancelPostgresBackend,
  runPostgresBatch,
  runPostgresExecute,
  runPostgresQuery
} from './postgres-query'

type QueryArg = string | { text: string; rowMode?: string }
function textOf(arg: QueryArg): string {
  return typeof arg === 'string' ? arg : arg.text
}

// Fake pooled client recording every query. Returns rows for pid + FETCH + direct.
function makeClient(fetchRows: unknown[][], fields: { name: string }[]) {
  const calls: string[] = []
  const release = vi.fn()
  const query = vi.fn((arg: QueryArg) => {
    const text = textOf(arg)
    calls.push(text)
    if (text.includes('pg_backend_pid')) {
      return Promise.resolve({ rows: [{ pid: 42 }] })
    }
    if (text.startsWith('FETCH FORWARD')) {
      return Promise.resolve({ rows: fetchRows, fields })
    }
    if (typeof arg === 'object') {
      // Direct (non-cursor) execution path.
      return Promise.resolve({ rows: fetchRows, fields, rowCount: fetchRows.length })
    }
    return Promise.resolve({ rows: [], rowCount: 0 })
  })
  return { calls, client: { query, release } }
}

function makePool(client: { query: unknown; release: unknown }) {
  return { connect: vi.fn(async () => client) } as never
}

function opts(overrides: Partial<QueryOptions> = {}): QueryOptions {
  return { rowLimit: 2, timeoutMs: 30_000, allowWrite: false, ...overrides }
}

describe('runPostgresQuery', () => {
  it('runs a read in a read-only transaction and bounds via a cursor', async () => {
    const { calls, client } = makeClient([[1], [2], [3]], [{ name: 'n' }])
    const onStart = vi.fn()
    const result = await runPostgresQuery(makePool(client), 'c1', 'SELECT * FROM t', opts(), onStart)

    expect(calls).toContain('BEGIN')
    expect(calls).toContain('SET TRANSACTION READ ONLY')
    expect(calls).toContain('COMMIT')
    // Cursor fetches rowLimit+1 to detect overflow; only rowLimit rows returned.
    expect(calls).toContain('FETCH FORWARD 3 FROM orca_query_cursor')
    expect(result.rows).toEqual([[1], [2]])
    expect(result.truncated).toBe(true)
    expect(result.rowCount).toBe(2)
    expect(onStart).toHaveBeenCalledWith({ connectionId: 'c1', backendPid: 42 })
    expect(client.release).toHaveBeenCalledTimes(1)
  })

  it('embeds the user SQL verbatim in DECLARE — never appends LIMIT', async () => {
    const { calls, client } = makeClient([[1]], [{ name: 'n' }])
    await runPostgresQuery(makePool(client), 'c1', 'SELECT * FROM t', opts(), vi.fn())
    const declare = calls.find((c) => c.startsWith('DECLARE'))
    expect(declare).toBe('DECLARE orca_query_cursor NO SCROLL CURSOR FOR SELECT * FROM t')
    expect(calls.some((c) => /\bLIMIT\b/i.test(c))).toBe(false)
  })

  it('runs a writable non-cursorable statement in autocommit (no transaction)', async () => {
    const { calls, client } = makeClient([], [])
    await runPostgresQuery(
      makePool(client),
      'c1',
      'INSERT INTO t VALUES (1)',
      opts({ allowWrite: true }),
      vi.fn()
    )
    expect(calls).not.toContain('SET TRANSACTION READ ONLY')
    // A write is non-cursorable → runs directly, no DECLARE.
    expect(calls.some((c) => c.startsWith('DECLARE'))).toBe(false)
    // No explicit transaction wraps it, so a transaction-block-unsafe command
    // (VACUUM, CREATE DATABASE, REINDEX CONCURRENTLY) isn't rejected.
    expect(calls).not.toContain('BEGIN')
    expect(calls).not.toContain('COMMIT')
  })

  it('does not open a transaction for VACUUM on a writable connection', async () => {
    const { calls, client } = makeClient([], [])
    await runPostgresQuery(
      makePool(client),
      'c1',
      'VACUUM ANALYZE t',
      opts({ allowWrite: true }),
      vi.fn()
    )
    expect(calls).not.toContain('BEGIN')
    expect(calls).not.toContain('COMMIT')
  })

  it('still wraps a writable cursorable read in a transaction for the cursor', async () => {
    const { calls, client } = makeClient([[1]], [{ name: 'n' }])
    await runPostgresQuery(
      makePool(client),
      'c1',
      'SELECT * FROM t',
      opts({ allowWrite: true }),
      vi.fn()
    )
    expect(calls).toContain('BEGIN')
    expect(calls).toContain('COMMIT')
    // Writable, so no read-only downgrade — but the cursor still bounds the read.
    expect(calls).not.toContain('SET TRANSACTION READ ONLY')
    expect(calls.some((c) => c.startsWith('DECLARE'))).toBe(true)
  })

  it('rolls back and rethrows when the query fails', async () => {
    const calls: string[] = []
    const client = {
      release: vi.fn(),
      query: vi.fn((arg: QueryArg) => {
        const text = textOf(arg)
        calls.push(text)
        if (text.includes('pg_backend_pid')) {
          return Promise.resolve({ rows: [{ pid: 7 }] })
        }
        if (text.startsWith('DECLARE')) {
          return Promise.reject(Object.assign(new Error('boom'), { code: '42P01' }))
        }
        return Promise.resolve({ rows: [], rowCount: 0 })
      })
    }
    await expect(
      runPostgresQuery(makePool(client), 'c1', 'SELECT * FROM missing', opts(), vi.fn())
    ).rejects.toThrow()
    expect(calls).toContain('ROLLBACK')
    expect(client.release).toHaveBeenCalledTimes(1)
  })
})

// Fake client for the parameterized execute/batch paths: records SQL + values.
function makeParamClient(rows: unknown[][], fields: { name: string }[]) {
  const calls: { text: string; values?: unknown[] }[] = []
  const release = vi.fn()
  const query = vi.fn((arg: QueryArg) => {
    const text = textOf(arg)
    const values = typeof arg === 'object' ? (arg as { values?: unknown[] }).values : undefined
    calls.push({ text, values })
    if (text.includes('pg_backend_pid')) {
      return Promise.resolve({ rows: [{ pid: 7 }] })
    }
    if (typeof arg === 'object' && 'rowMode' in arg) {
      return Promise.resolve({ rows, fields, rowCount: rows.length })
    }
    return Promise.resolve({ rows: [], rowCount: 1 })
  })
  return { calls, client: { query, release } }
}

describe('runPostgresExecute', () => {
  it('runs a read in a read-only transaction and threads bind params', async () => {
    const { calls, client } = makeParamClient([[1], [2]], [{ name: 'n' }])
    const result = await runPostgresExecute(
      makePool(client),
      'c1',
      { sql: 'SELECT * FROM t WHERE a = $1 LIMIT 100 OFFSET 0', params: [5] },
      opts({ rowLimit: 1000 }),
      vi.fn()
    )
    const texts = calls.map((c) => c.text)
    expect(texts).toContain('BEGIN')
    expect(texts).toContain('SET TRANSACTION READ ONLY')
    expect(texts).toContain('COMMIT')
    const select = calls.find((c) => c.text.startsWith('SELECT * FROM t'))
    expect(select?.values).toEqual([5])
    expect(result.rows).toEqual([[1], [2]])
    expect(result.columns).toEqual([{ name: 'n' }])
  })

  it('omits READ ONLY on a writable connection', async () => {
    const { calls, client } = makeParamClient([], [])
    await runPostgresExecute(
      makePool(client),
      'c1',
      { sql: 'UPDATE t SET a = $1 WHERE id = $2', params: [1, 2] },
      opts({ allowWrite: true }),
      vi.fn()
    )
    expect(calls.map((c) => c.text)).not.toContain('SET TRANSACTION READ ONLY')
    expect(calls.map((c) => c.text)).toContain('COMMIT')
  })
})

describe('runPostgresBatch', () => {
  it('applies every statement in one transaction and returns per-statement counts', async () => {
    const { calls, client } = makeParamClient([], [])
    const counts = await runPostgresBatch(
      makePool(client),
      'c1',
      [
        { sql: 'UPDATE t SET a = $1 WHERE id = $2', params: [1, 10] },
        { sql: 'DELETE FROM t WHERE id = $1', params: [11] }
      ],
      opts({ allowWrite: true }),
      vi.fn()
    )
    const texts = calls.map((c) => c.text)
    expect(texts).toContain('BEGIN')
    expect(texts).toContain('COMMIT')
    expect(texts).not.toContain('ROLLBACK')
    expect(counts).toEqual([1, 1])
  })

  it('rolls back the whole batch and throws DbBatchError with the failing index', async () => {
    const calls: string[] = []
    const client = {
      release: vi.fn(),
      query: vi.fn((arg: QueryArg) => {
        const text = textOf(arg)
        calls.push(text)
        if (text.includes('pg_backend_pid')) {
          return Promise.resolve({ rows: [{ pid: 7 }] })
        }
        if (text.startsWith('DELETE')) {
          return Promise.reject(Object.assign(new Error('fk'), { code: '23503' }))
        }
        return Promise.resolve({ rows: [], rowCount: 1 })
      })
    }
    const err = await runPostgresBatch(
      makePool(client),
      'c1',
      [
        { sql: 'UPDATE t SET a = $1 WHERE id = $2', params: [1, 10] },
        { sql: 'DELETE FROM t WHERE id = $1', params: [11] }
      ],
      opts({ allowWrite: true }),
      vi.fn()
    ).catch((e) => e)
    expect(err).toBeInstanceOf(DbBatchError)
    expect((err as DbBatchError).failedIndex).toBe(1)
    expect(calls).toContain('ROLLBACK')
    expect(calls).not.toContain('COMMIT')
    expect(client.release).toHaveBeenCalledTimes(1)
  })
})

describe('cancelPostgresBackend', () => {
  it('issues pg_cancel_backend on a short-lived connection', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] })
    const end = vi.fn().mockResolvedValue(undefined)
    const connect = vi.fn().mockResolvedValue(undefined)
    await cancelPostgresBackend({ connect, query, end } as never, 99)
    expect(connect).toHaveBeenCalledTimes(1)
    expect(query).toHaveBeenCalledWith('SELECT pg_cancel_backend($1)', [99])
    expect(end).toHaveBeenCalledTimes(1)
  })
})

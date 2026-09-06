import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fakes = vi.hoisted(() => ({
  configs: [] as Array<Record<string, unknown>>,
  // Pool construction and pool shutdown interleaved, so "the schema pool is
  // gone before the serving pool opens" is checkable rather than assumed.
  lifecycle: [] as string[],
  query: vi.fn(async (_sql: string) => ({ rows: [], rowCount: 0 })),
  release: vi.fn(),
  end: vi.fn(async () => undefined)
}))

vi.mock('pg', () => ({
  default: {
    Pool: class {
      totalCount = 1
      idleCount = 1
      waitingCount = 0
      on = vi.fn()
      connect = vi.fn(async () => ({ query: fakes.query, release: fakes.release }))
      private readonly label: string

      constructor(config: Record<string, unknown>) {
        fakes.configs.push(config)
        this.label = `max=${String(config.max)} statement_timeout=${String(config.statement_timeout)}`
        fakes.lifecycle.push(`open ${this.label}`)
      }

      async end(): Promise<void> {
        fakes.lifecycle.push(`end ${this.label}`)
        await fakes.end()
      }
    }
  }
}))

import { openRelayDatabase, relayPostgresStatementTimeoutMs } from './database.js'
import { applyPostgresSchema } from './postgres-schema-startup.js'

const SCHEMA_POOL = {
  max: 1,
  application_name: 'orca-relay/director/director/schema',
  connectionTimeoutMillis: 2_000,
  // Why: DDL must not inherit the request deadline.
  statement_timeout: 0,
  lock_timeout: 1_000,
  idle_in_transaction_session_timeout: 5_000
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('PostgreSQL relay deadlines', () => {
  beforeEach(() => {
    fakes.configs.length = 0
    fakes.lifecycle.length = 0
    fakes.query.mockClear()
    fakes.release.mockClear()
    fakes.end.mockClear()
    delete process.env.ORCA_RELAY_POSTGRES_STATEMENT_TIMEOUT_MS
  })

  it('bounds pool acquisition, statements, locks, and abandoned transactions', async () => {
    const database = await openRelayDatabase({
      databaseUrl: 'postgresql://relay:secret@127.0.0.1:5432/relay',
      dataDir: './unused',
      poolMax: 3,
      applicationName: 'orca-relay/director/director'
    })

    expect(fakes.configs).toEqual([
      expect.objectContaining(SCHEMA_POOL),
      expect.objectContaining({
        max: 3,
        application_name: 'orca-relay/director/director',
        connectionTimeoutMillis: 2_000,
        statement_timeout: 5_000,
        lock_timeout: 1_000,
        idle_in_transaction_session_timeout: 5_000
      })
    ])
    await database.close()
  })

  // Why: an untimed session left open would be a standing way for request work
  // to escape the deadline this whole pool config exists to enforce.
  it('closes the untimed schema pool before the serving pool opens', async () => {
    const database = await openRelayDatabase({
      databaseUrl: 'postgresql://relay:secret@127.0.0.1:5432/relay',
      dataDir: './unused',
      poolMax: 3,
      applicationName: 'orca-relay/director/director'
    })

    expect(fakes.lifecycle).toEqual([
      'open max=1 statement_timeout=0',
      'end max=1 statement_timeout=0',
      'open max=3 statement_timeout=5000'
    ])
    await database.close()
  })

  it('applies the schema on the untimed pool, never on the serving one', async () => {
    fakes.query.mockClear()
    const ddl: string[] = []
    fakes.query.mockImplementation(async (sql: string) => {
      // Every statement issued before the serving pool exists is schema work.
      if (fakes.lifecycle.length === 1) ddl.push(sql)
      return { rows: [], rowCount: 0 }
    })
    const database = await openRelayDatabase({
      databaseUrl: 'postgresql://relay:secret@127.0.0.1:5432/relay',
      dataDir: './unused'
    })

    expect(ddl.length).toBeGreaterThan(0)
    // Statements can open with a leading `--` rationale comment.
    const body = (statement: string): string =>
      statement.replace(/^(?:\s*--[^\n]*\n)*\s*/, '')
    expect(ddl.every((statement) => /^CREATE\b/i.test(body(statement)))).toBe(true)
    // The backfill is DML, so it stays on the deadline-bearing serving pool.
    expect(ddl.some((statement) => statement.includes('INSERT INTO'))).toBe(false)
    await database.close()
  })

  it('takes the serving statement deadline from the environment', async () => {
    process.env.ORCA_RELAY_POSTGRES_STATEMENT_TIMEOUT_MS = '2500'

    const database = await openRelayDatabase({
      databaseUrl: 'postgresql://relay:secret@127.0.0.1:5432/relay',
      dataDir: './unused'
    })

    expect(fakes.configs).toEqual([
      expect.objectContaining({ statement_timeout: 0 }),
      expect.objectContaining({ statement_timeout: 2_500 })
    ])
    await database.close()
  })

  it.each(['0', '-1', '2.5', 'soon', ' '])(
    'refuses %s as a statement deadline instead of running unbounded',
    (value) => {
      expect(() =>
        relayPostgresStatementTimeoutMs({ ORCA_RELAY_POSTGRES_STATEMENT_TIMEOUT_MS: value })
      ).toThrow('invalid_statement_timeout')
    }
  )

  it.each([undefined, ''])('defaults to 5s when the environment says %s', (value) => {
    expect(
      relayPostgresStatementTimeoutMs(
        value === undefined ? {} : { ORCA_RELAY_POSTGRES_STATEMENT_TIMEOUT_MS: value }
      )
    ).toBe(5_000)
  })

  // Why: a statement deadline that reaches the caller as a crash converts a
  // transient stall into a failed assignment. It aborts the transaction exactly
  // as a lock timeout does, so it belongs on the same bounded retry.
  it('retries a statement timeout on a fresh client', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const database = await openRelayDatabase({
      databaseUrl: 'postgresql://relay:secret@127.0.0.1:5432/relay',
      dataDir: './unused'
    })
    let attempts = 0

    const result = await database.transaction(async (transaction) => {
      attempts += 1
      if (attempts === 1) {
        await transaction.query('SELECT 1')
        throw Object.assign(new Error('canceling statement due to statement timeout'), {
          code: '57014'
        })
      }
      return 'committed'
    })

    expect(result).toBe('committed')
    expect(attempts).toBe(2)
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('"event":"orca_relay_postgres_transaction_retry"')
    )
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('"code":"57014"'))
    await database.close()
  })
})

describe('PostgreSQL schema startup', () => {
  it('retries lock and statement timeouts with bounded backoff', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const query = vi
      .fn<(statement: string) => Promise<unknown>>()
      .mockRejectedValueOnce(Object.assign(new Error('lock timeout'), { code: '55P03' }))
      .mockRejectedValueOnce(Object.assign(new Error('statement timeout'), { code: '57014' }))
      .mockResolvedValue(undefined)
    const delays: number[] = []

    await applyPostgresSchema(['CREATE TABLE test'], query, {
      random: () => 0,
      wait: async (delayMs) => {
        delays.push(delayMs)
      }
    })

    expect(query).toHaveBeenCalledTimes(3)
    expect(delays).toEqual([125, 250])
  })

  it('retries only the PostgreSQL concurrent type-creation collision', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const collision = Object.assign(new Error('duplicate type'), {
      code: '23505',
      constraint: 'pg_type_typname_nsp_index'
    })
    const query = vi
      .fn<(statement: string) => Promise<unknown>>()
      .mockRejectedValueOnce(collision)
      .mockResolvedValue(undefined)

    await applyPostgresSchema(['CREATE TABLE IF NOT EXISTS test'], query, {
      wait: async () => undefined
    })

    expect(query).toHaveBeenCalledTimes(2)
  })

  it('retries only the PostgreSQL concurrent index-creation collision', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const collision = Object.assign(new Error('duplicate index'), {
      code: '23505',
      constraint: 'pg_class_relname_nsp_index'
    })
    const query = vi
      .fn<(statement: string) => Promise<unknown>>()
      .mockRejectedValueOnce(collision)
      .mockResolvedValue(undefined)

    await applyPostgresSchema(['CREATE INDEX IF NOT EXISTS test_index ON test(id)'], query, {
      wait: async () => undefined
    })

    expect(query).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['42710', 'CREATE TABLE IF NOT EXISTS test'],
    ['42P07', 'CREATE TABLE IF NOT EXISTS test'],
    ['42P07', 'CREATE INDEX IF NOT EXISTS test_index ON test(id)'],
    ['42P07', 'CREATE UNIQUE INDEX IF NOT EXISTS test_index ON test(id)']
  ])('retries the committed-winner %s collision for %s', async (code, statement) => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const collision = Object.assign(new Error('already exists'), { code })
    const query = vi
      .fn<(statement: string) => Promise<unknown>>()
      .mockRejectedValueOnce(collision)
      .mockResolvedValue(undefined)

    await applyPostgresSchema([statement], query, { wait: async () => undefined })

    expect(query).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['42710', 'CREATE INDEX IF NOT EXISTS test_index ON test(id)'],
    ['42710', 'CREATE TABLE test'],
    ['42P07', 'CREATE TABLE test'],
    ['42P07', 'CREATE INDEX test_index ON test(id)']
  ])('does not retry %s for %s', async (code, statement) => {
    const error = Object.assign(new Error('already exists'), { code })
    const query = vi.fn<(statement: string) => Promise<unknown>>().mockRejectedValue(error)
    const pause = vi.fn(async () => undefined)

    await expect(applyPostgresSchema([statement], query, { wait: pause })).rejects.toBe(error)

    expect(pause).not.toHaveBeenCalled()
  })

  it.each([
    ['pg_type_typname_nsp_index', 'CREATE TABLE test'],
    ['pg_class_relname_nsp_index', 'CREATE INDEX test_index ON test(id)']
  ])('does not retry %s for non-idempotent DDL', async (constraint, statement) => {
    const error = Object.assign(new Error('duplicate catalog object'), {
      code: '23505',
      constraint
    })
    const query = vi.fn<(statement: string) => Promise<unknown>>().mockRejectedValue(error)
    const pause = vi.fn(async () => undefined)

    await expect(
      applyPostgresSchema([statement], query, { wait: pause })
    ).rejects.toBe(error)

    expect(pause).not.toHaveBeenCalled()
  })

  it('does not retry unrelated unique violations', async () => {
    const error = Object.assign(new Error('duplicate row'), {
      code: '23505',
      constraint: 'application_key'
    })
    const query = vi.fn<(statement: string) => Promise<unknown>>().mockRejectedValue(error)
    const pause = vi.fn(async () => undefined)

    await expect(
      applyPostgresSchema(['CREATE TABLE test'], query, { wait: pause })
    ).rejects.toBe(error)

    expect(pause).not.toHaveBeenCalled()
  })

  it('fails immediately for non-timeout schema errors', async () => {
    const error = Object.assign(new Error('permission denied'), { code: '42501' })
    const query = vi.fn<(statement: string) => Promise<unknown>>().mockRejectedValue(error)
    const pause = vi.fn(async () => undefined)

    await expect(
      applyPostgresSchema(['CREATE TABLE test'], query, { wait: pause })
    ).rejects.toBe(error)

    expect(query).toHaveBeenCalledTimes(1)
    expect(pause).not.toHaveBeenCalled()
  })

  it('stops retrying at the shared startup deadline', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const error = Object.assign(new Error('lock timeout'), { code: '55P03' })
    const delays: number[] = []
    let now = 0
    const query = vi
      .fn<(statement: string) => Promise<unknown>>()
      .mockImplementationOnce(async () => {
        now = 200
      })
      .mockRejectedValue(error)

    await expect(
      applyPostgresSchema(['CREATE TABLE first', 'CREATE TABLE second'], query, {
        now: () => now,
        random: () => 1,
        retryDeadlineMs: 300,
        wait: async (delayMs) => {
          delays.push(delayMs)
          now += delayMs
        }
      })
    ).rejects.toBe(error)

    expect(query).toHaveBeenCalledTimes(3)
    expect(delays).toEqual([100])
    expect(console.warn).toHaveBeenLastCalledWith(
      JSON.stringify({
        event: 'orca_relay_postgres_schema_retry_exhausted',
        code: '55P03',
        attempts: 2
      })
    )
  })
})

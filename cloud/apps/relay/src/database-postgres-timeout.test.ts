import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fakes = vi.hoisted(() => ({
  configs: [] as Array<Record<string, unknown>>,
  query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
  release: vi.fn(),
  end: vi.fn(async () => undefined)
}))

vi.mock('pg', () => ({
  default: {
    Pool: class {
      totalCount = 1
      idleCount = 1
      waitingCount = 0
      end = fakes.end
      on = vi.fn()
      connect = vi.fn(async () => ({ query: fakes.query, release: fakes.release }))

      constructor(config: Record<string, unknown>) {
        fakes.configs.push(config)
      }
    }
  }
}))

import { openRelayDatabase } from './database.js'
import { applyPostgresSchema } from './postgres-schema-startup.js'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('PostgreSQL relay deadlines', () => {
  beforeEach(() => {
    fakes.configs.length = 0
    fakes.query.mockClear()
    fakes.release.mockClear()
    fakes.end.mockClear()
  })

  it('bounds pool acquisition, statements, locks, and abandoned transactions', async () => {
    const database = await openRelayDatabase({
      databaseUrl: 'postgresql://relay:secret@127.0.0.1:5432/relay',
      dataDir: './unused',
      poolMax: 3,
      applicationName: 'orca-relay/director/director'
    })

    expect(fakes.configs).toEqual([
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

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ResolvedDbConfig } from './db-driver'

// Fake pg.Pool capturing config + listeners so we can assert the driver wires
// the mandatory 'error' listener and validates before returning.
const okConnect = (): Promise<unknown> =>
  Promise.resolve({ query: vi.fn().mockResolvedValue({ rows: [] }), release: vi.fn() })

class FakePool {
  static instances: FakePool[] = []
  // Constructor-time override so a test can arm failing validation before the
  // driver's internal `await import('pg')` resolves and creates the pool.
  static nextConnect: (() => Promise<unknown>) | null = null
  // Rows returned by pool-level introspection queries (pg returns { rows }).
  static queryRows: unknown[] = []
  config: Record<string, unknown>
  listeners: Record<string, (arg: unknown) => void> = {}
  ended = false
  connectImpl: () => Promise<unknown>

  constructor(config: Record<string, unknown>) {
    this.config = config
    this.connectImpl = FakePool.nextConnect ?? okConnect
    FakePool.nextConnect = null
    FakePool.instances.push(this)
  }

  on(event: string, cb: (arg: unknown) => void): void {
    this.listeners[event] = cb
  }

  connect(): Promise<unknown> {
    return this.connectImpl()
  }

  query(): Promise<{ rows: unknown[] }> {
    return Promise.resolve({ rows: FakePool.queryRows })
  }

  async end(): Promise<void> {
    this.ended = true
  }
}

vi.mock('pg', () => ({ default: { Pool: FakePool } }))

import { buildPgPoolConfig, buildPgSsl, postgresDriver } from './postgres-driver'

function cfg(overrides: Partial<ResolvedDbConfig> = {}): ResolvedDbConfig {
  return {
    id: 'c1',
    engine: 'postgres',
    host: 'db.example.com',
    port: 5432,
    database: 'app',
    user: 'admin',
    password: 'pw',
    ssl: 'verify-full',
    readOnly: false,
    ...overrides
  }
}

describe('buildPgSsl', () => {
  it('disables TLS for ssl=disable', () => {
    expect(buildPgSsl('disable')).toBe(false)
  })

  it('verifies certs for ssl=verify-full', () => {
    expect(buildPgSsl('verify-full')).toEqual({ rejectUnauthorized: true })
  })

  it('does not verify certs for ssl=insecure-no-verify', () => {
    expect(buildPgSsl('insecure-no-verify')).toEqual({ rejectUnauthorized: false })
  })
})

describe('buildPgPoolConfig', () => {
  it('sets a bounded connect timeout and a small pool', () => {
    const pool = buildPgPoolConfig(cfg())
    expect(pool.connectionTimeoutMillis).toBeGreaterThan(0)
    expect(pool.max).toBe(2)
    expect(pool.ssl).toEqual({ rejectUnauthorized: true })
  })
})

describe('postgresDriver', () => {
  beforeEach(() => {
    FakePool.instances = []
    FakePool.nextConnect = null
    FakePool.queryRows = []
  })

  it('connect attaches an error listener, validates, and returns a live connection', async () => {
    const onError = vi.fn()
    const conn = await postgresDriver.connect(cfg(), onError)
    const pool = FakePool.instances[0]
    expect(pool.listeners.error).toBeTypeOf('function')
    expect(conn.engine).toBe('postgres')
    expect(conn.raw).toBe(pool)

    // The wired listener forwards a dropped-connection error to the manager.
    pool.listeners.error(new Error('idle client error'))
    expect(onError).toHaveBeenCalledTimes(1)
  })

  it('connect ends the pool and rethrows when validation fails', async () => {
    // Arm the next pool to fail its validation query before connect creates it.
    FakePool.nextConnect = () =>
      Promise.resolve({
        query: vi.fn().mockRejectedValue(Object.assign(new Error('nope'), { code: '28P01' })),
        release: vi.fn()
      })
    await expect(postgresDriver.connect(cfg(), vi.fn())).rejects.toThrow()
    expect(FakePool.instances[0].ended).toBe(true)
  })

  it('testConnection ends the pool even on success (holds no state)', async () => {
    await postgresDriver.testConnection(cfg())
    expect(FakePool.instances[0].ended).toBe(true)
  })

  it('introspectSchemas maps rows and flags truncation past the cap', async () => {
    const conn = await postgresDriver.connect(cfg(), vi.fn())
    FakePool.queryRows = [{ name: 'public' }, { name: 'app' }, { name: 'extra' }]
    const tree = await postgresDriver.introspectSchemas(conn, 2)
    expect(tree.schemas).toEqual(['public', 'app'])
    expect(tree.truncated).toBe(true)
  })

  it('introspectColumns maps nullability and primary-key membership', async () => {
    const conn = await postgresDriver.connect(cfg(), vi.fn())
    FakePool.queryRows = [
      { name: 'id', data_type: 'integer', is_nullable: 'NO', is_primary_key: true }
    ]
    const columns = await postgresDriver.introspectColumns(conn, { schema: 'public', table: 't' })
    expect(columns).toEqual([
      { name: 'id', dataType: 'integer', nullable: false, isPrimaryKey: true }
    ])
  })
})

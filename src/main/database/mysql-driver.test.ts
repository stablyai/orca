import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ResolvedDbConfig } from './db-driver'

type ConnListener = (conn: unknown) => void

// Fake mysql2/promise pool. The core (callback) pool is exposed via `.pool`, which
// is where the driver attaches the 'connection' listener that wires per-connection
// 'error' forwarding (red-team F4).
class FakePool {
  static instances: FakePool[] = []
  static nextGetConnection: (() => Promise<unknown>) | null = null
  // Rows returned by pool-level introspection queries (mysql2 returns [rows]).
  static queryRows: unknown[] = []
  config: Record<string, unknown>
  connectionListener: ConnListener | null = null
  ended = false
  pool = {
    on: (event: string, cb: ConnListener): void => {
      if (event === 'connection') {
        this.connectionListener = cb
      }
    }
  }
  getConnectionImpl: () => Promise<unknown>

  constructor(config: Record<string, unknown>) {
    this.config = config
    this.getConnectionImpl =
      FakePool.nextGetConnection ??
      (() => Promise.resolve({ query: vi.fn().mockResolvedValue([[]]), release: vi.fn() }))
    FakePool.nextGetConnection = null
    FakePool.instances.push(this)
  }

  getConnection(): Promise<unknown> {
    return this.getConnectionImpl()
  }

  query(): Promise<[unknown[], unknown[]]> {
    return Promise.resolve([FakePool.queryRows, []])
  }

  async end(): Promise<void> {
    this.ended = true
  }
}

vi.mock('mysql2/promise', () => ({
  default: { createPool: (config: Record<string, unknown>) => new FakePool(config) }
}))

import { buildMysqlPoolConfig, buildMysqlSsl, mysqlDriver } from './mysql-driver'

function cfg(overrides: Partial<ResolvedDbConfig> = {}): ResolvedDbConfig {
  return {
    id: 'c1',
    engine: 'mysql',
    host: 'db.example.com',
    port: 3306,
    database: 'app',
    user: 'admin',
    password: 'pw',
    ssl: 'verify-full',
    readOnly: false,
    ...overrides
  }
}

describe('buildMysqlSsl', () => {
  it('omits TLS for ssl=disable', () => {
    expect(buildMysqlSsl('disable')).toBeUndefined()
  })

  it('verifies certs for ssl=verify-full', () => {
    expect(buildMysqlSsl('verify-full')).toEqual({ rejectUnauthorized: true })
  })

  it('does not verify certs for ssl=insecure-no-verify', () => {
    expect(buildMysqlSsl('insecure-no-verify')).toEqual({ rejectUnauthorized: false })
  })
})

describe('buildMysqlPoolConfig', () => {
  it('disables the LOCAL INFILE and multi-statement vectors', () => {
    const config = buildMysqlPoolConfig(cfg())
    expect('infileStreamFactory' in config).toBe(true)
    expect(config.infileStreamFactory).toBeUndefined()
    expect(config.multipleStatements).toBe(false)
  })

  it('sets a bounded connect timeout and a small pool', () => {
    const config = buildMysqlPoolConfig(cfg())
    expect(config.connectTimeout).toBeGreaterThan(0)
    expect(config.connectionLimit).toBe(2)
    expect(config.ssl).toEqual({ rejectUnauthorized: true })
  })
})

describe('mysqlDriver', () => {
  beforeEach(() => {
    FakePool.instances = []
    FakePool.nextGetConnection = null
    FakePool.queryRows = []
  })

  it('connect wires per-connection error forwarding and returns a live connection', async () => {
    const onError = vi.fn()
    const conn = await mysqlDriver.connect(cfg(), onError)
    const pool = FakePool.instances[0]
    expect(pool.connectionListener).toBeTypeOf('function')
    expect(conn.engine).toBe('mysql')

    // A pooled connection's 'error' must reach the manager, not crash the process.
    const listeners: Record<string, (err: unknown) => void> = {}
    pool.connectionListener?.({
      on: (event: string, cb: (err: unknown) => void) => {
        listeners[event] = cb
      }
    })
    listeners.error?.(new Error('socket dropped'))
    expect(onError).toHaveBeenCalledTimes(1)
  })

  it('connect ends the pool and rethrows when validation fails', async () => {
    FakePool.nextGetConnection = () =>
      Promise.resolve({
        query: vi.fn().mockRejectedValue(
          Object.assign(new Error('denied'), { code: 'ER_ACCESS_DENIED_ERROR' })
        ),
        release: vi.fn()
      })
    await expect(mysqlDriver.connect(cfg(), vi.fn())).rejects.toThrow()
    expect(FakePool.instances[0].ended).toBe(true)
  })

  it('testConnection ends the pool even on success', async () => {
    await mysqlDriver.testConnection(cfg())
    expect(FakePool.instances[0].ended).toBe(true)
  })

  it('introspectTables maps kinds and flags truncation past the cap', async () => {
    const conn = await mysqlDriver.connect(cfg(), vi.fn())
    FakePool.queryRows = [
      { name: 'a', type: 'BASE TABLE' },
      { name: 'b', type: 'VIEW' },
      { name: 'c', type: 'BASE TABLE' }
    ]
    const list = await mysqlDriver.introspectTables(conn, 'app', 2)
    expect(list.tables).toEqual([
      { name: 'a', kind: 'table' },
      { name: 'b', kind: 'view' }
    ])
    expect(list.truncated).toBe(true)
  })

  it('introspectColumns maps column_key=PRI to primary key', async () => {
    const conn = await mysqlDriver.connect(cfg(), vi.fn())
    FakePool.queryRows = [
      { name: 'id', data_type: 'int', is_nullable: 'NO', column_key: 'PRI' }
    ]
    const columns = await mysqlDriver.introspectColumns(conn, { schema: 'app', table: 'users' })
    expect(columns).toEqual([{ name: 'id', dataType: 'int', nullable: false, isPrimaryKey: true }])
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DbConnectionRuntimeState } from '../../shared/database-types'
import type { LiveConnection, ResolvedDbConfig } from './db-driver'

// Controllable fake drivers so the manager's lifecycle can be exercised without
// pg/mysql2. `capturedOnError` lets a test simulate a dropped connection.
const { pgDriver, mysqlDriver, state } = vi.hoisted(() => {
  const shared = { capturedOnError: null as ((err: unknown) => void) | null }
  const makeDriver = (engine: 'postgres' | 'mysql') => ({
    testConnection: vi.fn(async () => {}),
    connect: vi.fn(async (cfg: ResolvedDbConfig, onError: (err: unknown) => void) => {
      shared.capturedOnError = onError
      return { id: cfg.id, engine, raw: {} } as LiveConnection
    }),
    introspectSchemas: vi.fn(async () => ({ schemas: ['public'], truncated: false })),
    introspectTables: vi.fn(async () => ({ tables: [], truncated: false })),
    introspectColumns: vi.fn(async () => []),
    close: vi.fn(async () => {})
  })
  return { pgDriver: makeDriver('postgres'), mysqlDriver: makeDriver('mysql'), state: shared }
})

vi.mock('./postgres-driver', () => ({ postgresDriver: pgDriver }))
vi.mock('./mysql-driver', () => ({ mysqlDriver }))

import { DbConnectionManager } from './db-connection-manager'

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

describe('DbConnectionManager', () => {
  let manager: DbConnectionManager
  let statuses: DbConnectionRuntimeState[]

  beforeEach(() => {
    vi.clearAllMocks()
    state.capturedOnError = null
    manager = new DbConnectionManager()
    statuses = []
    manager.setStatusListener((s) => statuses.push(s))
  })

  it('connect transitions connecting → connected and holds the connection', async () => {
    const result = await manager.connect(cfg())
    expect(result.status).toBe('connected')
    expect(manager.getConnection('c1')).toBeDefined()
    expect(statuses.map((s) => s.status)).toEqual(['connecting', 'connected'])
  })

  it('routes by engine to the matching driver', async () => {
    await manager.connect(cfg({ id: 'm1', engine: 'mysql' }))
    expect(mysqlDriver.connect).toHaveBeenCalledTimes(1)
    expect(pgDriver.connect).not.toHaveBeenCalled()
  })

  it('rejects a concurrent connect for the same id (race guard)', async () => {
    let release: (() => void) | undefined
    pgDriver.connect.mockImplementationOnce(
      (c: ResolvedDbConfig) =>
        new Promise((resolve) => {
          release = () => resolve({ id: c.id, engine: 'postgres', raw: {} } as LiveConnection)
        })
    )
    const first = manager.connect(cfg())
    await expect(manager.connect(cfg())).rejects.toThrow('db_connect_in_progress')
    release?.()
    await first
  })

  it('returns the existing state without re-dialing when already connected', async () => {
    await manager.connect(cfg())
    await manager.connect(cfg())
    expect(pgDriver.connect).toHaveBeenCalledTimes(1)
  })

  it('marks error and rethrows when the driver fails to connect', async () => {
    pgDriver.connect.mockRejectedValueOnce(Object.assign(new Error('x'), { code: '28P01' }))
    await expect(manager.connect(cfg())).rejects.toThrow()
    const last = statuses.at(-1)
    expect(last?.status).toBe('error')
    expect(last?.error?.code).toBe('auth_failed')
    expect(manager.getConnection('c1')).toBeUndefined()
  })

  it('degrades a dropped connection to lost without crashing, and drops it', async () => {
    await manager.connect(cfg())
    expect(state.capturedOnError).toBeTypeOf('function')
    // Simulate the driver 'error' event on a live connection.
    state.capturedOnError?.(Object.assign(new Error('reset'), { code: 'ECONNRESET' }))
    expect(manager.getStatus('c1').status).toBe('lost')
    expect(manager.getConnection('c1')).toBeUndefined()
    expect(pgDriver.close).toHaveBeenCalledTimes(1)
  })

  it('disconnect closes the pool and resets status to idle', async () => {
    await manager.connect(cfg())
    await manager.disconnect('c1')
    expect(pgDriver.close).toHaveBeenCalledTimes(1)
    expect(manager.getStatus('c1').status).toBe('idle')
    expect(manager.getConnection('c1')).toBeUndefined()
  })

  it('disconnectAll closes every held connection', async () => {
    await manager.connect(cfg({ id: 'c1' }))
    await manager.connect(cfg({ id: 'm1', engine: 'mysql' }))
    await manager.disconnectAll()
    expect(pgDriver.close).toHaveBeenCalledTimes(1)
    expect(mysqlDriver.close).toHaveBeenCalledTimes(1)
    expect(manager.getConnection('c1')).toBeUndefined()
    expect(manager.getConnection('m1')).toBeUndefined()
  })

  it('test performs a one-shot ping and holds no state', async () => {
    await manager.test(cfg())
    expect(pgDriver.testConnection).toHaveBeenCalledTimes(1)
    expect(manager.getConnection('c1')).toBeUndefined()
    expect(manager.getStatus('c1').status).toBe('idle')
  })

  describe('introspection', () => {
    it('throws db_not_connected when no live connection is held', async () => {
      await expect(manager.introspectSchemas('missing')).rejects.toThrow('db_not_connected')
      await expect(manager.introspectTables('missing', 'public')).rejects.toThrow(
        'db_not_connected'
      )
      await expect(
        manager.introspectColumns('missing', { schema: 'public', table: 't' })
      ).rejects.toThrow('db_not_connected')
    })

    it('delegates to the connection engine driver with caps', async () => {
      await manager.connect(cfg())
      await manager.introspectSchemas('c1')
      await manager.introspectTables('c1', 'public')
      await manager.introspectColumns('c1', { schema: 'public', table: 'users' })
      expect(pgDriver.introspectSchemas).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'c1' }),
        expect.any(Number)
      )
      expect(pgDriver.introspectTables).toHaveBeenCalledWith(
        expect.anything(),
        'public',
        expect.any(Number)
      )
      expect(pgDriver.introspectColumns).toHaveBeenCalledWith(expect.anything(), {
        schema: 'public',
        table: 'users'
      })
    })
  })
})

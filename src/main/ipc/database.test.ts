import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '../persistence'
import type {
  DbConnection,
  DbConnectionInput,
  DbConnectionRuntimeState,
  DbConnectionSummary,
  DbConnectionUpdate
} from '../../shared/database-types'

const { handleMock, removeHandlerMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  removeHandlerMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: handleMock,
    removeHandler: removeHandlerMock
  },
  BrowserWindow: {
    getAllWindows: () => []
  }
}))

const { getDbEncryptionStatusMock, decryptDbSecretMock } = vi.hoisted(() => ({
  getDbEncryptionStatusMock: vi.fn(() => ({
    backend: 'mock-backend',
    isStrong: true
  })),
  // Strip the at-rest tag so resolved configs carry the plaintext secret.
  decryptDbSecretMock: vi.fn((stored: string) =>
    stored.replace(/^db\.(safeStorage|plaintext)\.v1:/, '')
  )
}))

vi.mock('../database/db-credential-store', () => ({
  getDbEncryptionStatus: getDbEncryptionStatusMock,
  decryptDbSecret: decryptDbSecretMock
}))

// Manager double: the real manager would load pg/mysql2 and dial a live server.
const { managerMock } = vi.hoisted(() => ({
  managerMock: {
    setStatusListener: vi.fn(),
    test: vi.fn(async () => {}),
    connect: vi.fn(async (cfg: { id: string }) => ({ id: cfg.id, status: 'connected' as const })),
    disconnect: vi.fn(async () => {}),
    getAllStatuses: vi.fn((): DbConnectionRuntimeState[] => []),
    introspectSchemas: vi.fn(async () => ({ schemas: ['public'], truncated: false })),
    introspectTables: vi.fn(async () => ({ tables: [{ name: 'users', kind: 'table' }], truncated: false })),
    introspectColumns: vi.fn(async () => [
      { name: 'id', dataType: 'int', nullable: false, isPrimaryKey: true }
    ]),
    query: vi.fn(async () => ({
      columns: [{ name: 'n' }],
      rows: [[1]],
      rowCount: 1,
      truncated: false,
      durationMs: 3
    })),
    cancelQuery: vi.fn(async () => {})
  }
}))

vi.mock('../database/db-connection-manager', () => ({ dbConnectionManager: managerMock }))

const { isTrustedUIRendererMock } = vi.hoisted(() => ({
  isTrustedUIRendererMock: vi.fn(
    (sender: Record<string, unknown>) => sender.isTrusted === true
  )
}))

vi.mock('./ui', () => ({
  isTrustedUIRenderer: isTrustedUIRendererMock
}))

import { registerDatabaseHandlers } from './database'

function makeStore(overrides: Partial<Store> = {}): Store {
  return {
    getDbConnections: vi.fn(() => []),
    getDbConnection: vi.fn(),
    addDbConnection: vi.fn(),
    updateDbConnection: vi.fn(),
    removeDbConnection: vi.fn(),
    ...overrides
  } as unknown as Store
}

function makeEvent(senderOverrides: Record<string, unknown> = {}) {
  return {
    sender: {
      id: 1,
      ...senderOverrides
    }
  }
}

function makeDbConnection(overrides: Partial<DbConnection> = {}): DbConnection {
  return {
    id: 'conn-1',
    name: 'test-db',
    engine: 'postgres' as const,
    host: 'localhost',
    port: 5432,
    database: 'testdb',
    user: 'testuser',
    password: 'db.safeStorage.v1:encrypted-secret',
    ssl: 'verify-full' as const,
    readOnly: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides
  }
}

describe('registerDatabaseHandlers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    handleMock.mockReset()
    removeHandlerMock.mockReset()
  })

  describe('initialization', () => {
    it('registers all database IPC channels', () => {
      const store = makeStore()

      registerDatabaseHandlers(store)

      const expected = [
        'database:list',
        'database:add',
        'database:update',
        'database:remove',
        'database:encryptionStatus',
        'database:test',
        'database:connect',
        'database:disconnect',
        'database:statuses',
        'database:introspect',
        'database:introspectSchemaTables',
        'database:introspectTableColumns',
        'database:query',
        'database:cancelQuery'
      ]
      for (const channel of expected) {
        expect(removeHandlerMock).toHaveBeenCalledWith(channel)
      }
      expect(handleMock).toHaveBeenCalledTimes(expected.length)
      expect(handleMock.mock.calls.map(([channel]) => channel)).toEqual(expected)
    })

    it('can be called multiple times without error', () => {
      const store = makeStore()

      expect(() => {
        registerDatabaseHandlers(store)
        registerDatabaseHandlers(store)
      }).not.toThrow()
    })
  })

  describe('database:list', () => {
    it('returns empty list when no connections', () => {
      const store = makeStore({
        getDbConnections: vi.fn(() => [])
      })
      registerDatabaseHandlers(store)

      const handler = handleMock.mock.calls.find(([ch]) => ch === 'database:list')?.[1]
      const event = makeEvent({ isTrusted: true })

      const result = handler?.(event)

      expect(result).toEqual([])
    })

    it('returns connections as summaries without password field', () => {
      const conn = makeDbConnection({
        id: 'id-1',
        name: 'db1',
        password: 'db.safeStorage.v1:secret'
      })
      const store = makeStore({
        getDbConnections: vi.fn(() => [conn])
      })
      registerDatabaseHandlers(store)

      const handler = handleMock.mock.calls.find(([ch]) => ch === 'database:list')?.[1]
      const event = makeEvent({ isTrusted: true })

      const result = handler?.(event) as DbConnectionSummary[]

      expect(result).toHaveLength(1)
      expect(result[0].id).toBe('id-1')
      expect(result[0].name).toBe('db1')
      expect(result[0].hasPassword).toBe(true)
      expect('password' in result[0]).toBe(false)
    })

    it('sets hasPassword=false when connection has no password', () => {
      const conn = makeDbConnection({ password: undefined })
      const store = makeStore({
        getDbConnections: vi.fn(() => [conn])
      })
      registerDatabaseHandlers(store)

      const handler = handleMock.mock.calls.find(([ch]) => ch === 'database:list')?.[1]
      const event = makeEvent({ isTrusted: true })

      const result = handler?.(event) as DbConnectionSummary[]

      expect(result[0].hasPassword).toBe(false)
    })

    it('rejects untrusted sender', () => {
      const store = makeStore()
      registerDatabaseHandlers(store)

      const handler = handleMock.mock.calls.find(([ch]) => ch === 'database:list')?.[1]
      const event = makeEvent({ isTrusted: false })

      expect(() => handler?.(event)).toThrow('untrusted_sender')
    })
  })

  describe('database:add', () => {
    it('sanitizes input and adds connection', () => {
      const addedConn = makeDbConnection({ id: 'new-id' })
      const store = makeStore({
        addDbConnection: vi.fn(() => addedConn)
      })
      registerDatabaseHandlers(store)

      const handler = handleMock.mock.calls.find(([ch]) => ch === 'database:add')?.[1]
      const event = makeEvent({ isTrusted: true })
      const input: DbConnectionInput = {
        name: 'mydb',
        engine: 'postgres',
        host: 'db.example.com',
        port: 5432,
        database: 'mydb',
        user: 'user',
        password: 'secret'
      }

      const result = handler?.(event, { input }) as DbConnectionSummary

      expect(store.addDbConnection).toHaveBeenCalled()
      expect(result.id).toBe('new-id')
      expect('password' in result).toBe(false)
      expect(result.hasPassword).toBe(true)
    })

    it('coerces port to integer', () => {
      const addedConn = makeDbConnection()
      const store = makeStore({
        addDbConnection: vi.fn(() => addedConn)
      })
      registerDatabaseHandlers(store)

      const handler = handleMock.mock.calls.find(([ch]) => ch === 'database:add')?.[1]
      const event = makeEvent({ isTrusted: true })
      const input = {
        name: 'db',
        engine: 'postgres' as const,
        host: 'localhost',
        port: '5432' as unknown as number,
        database: 'db',
        user: 'user'
      }

      handler?.(event, { input })

      const callArg = vi.mocked(store.addDbConnection).mock.calls[0][0]
      expect(callArg.port).toBe(5432)
      expect(typeof callArg.port).toBe('number')
    })

    it('rejects invalid port', () => {
      const store = makeStore()
      registerDatabaseHandlers(store)

      const handler = handleMock.mock.calls.find(([ch]) => ch === 'database:add')?.[1]
      const event = makeEvent({ isTrusted: true })
      const input = {
        name: 'db',
        engine: 'postgres' as const,
        host: 'localhost',
        port: 99999,
        database: 'db',
        user: 'user'
      }

      expect(() => handler?.(event, { input })).toThrow('invalid_port')
    })

    it('rejects invalid engine', () => {
      const store = makeStore()
      registerDatabaseHandlers(store)

      const handler = handleMock.mock.calls.find(([ch]) => ch === 'database:add')?.[1]
      const event = makeEvent({ isTrusted: true })
      const input = {
        name: 'db',
        engine: 'sqlite' as unknown as DbConnectionInput['engine'],
        host: 'localhost',
        port: 5432,
        database: 'db',
        user: 'user'
      }

      expect(() => handler?.(event, { input })).toThrow('invalid_engine')
    })

    it('rejects untrusted sender', () => {
      const store = makeStore()
      registerDatabaseHandlers(store)

      const handler = handleMock.mock.calls.find(([ch]) => ch === 'database:add')?.[1]
      const event = makeEvent({ isTrusted: false })
      const input = makeDbConnection()

      expect(() => handler?.(event, { input })).toThrow('untrusted_sender')
      expect(store.addDbConnection).not.toHaveBeenCalled()
    })
  })

  describe('database:update', () => {
    it('returns password-stripped summary on success', () => {
      const updated = makeDbConnection({ id: 'id-1', name: 'updated' })
      const store = makeStore({
        updateDbConnection: vi.fn(() => updated)
      })
      registerDatabaseHandlers(store)

      const handler = handleMock.mock.calls.find(([ch]) => ch === 'database:update')?.[1]
      const event = makeEvent({ isTrusted: true })
      const updates: DbConnectionUpdate = { name: 'updated' }

      const result = handler?.(event, { id: 'id-1', updates }) as DbConnectionSummary

      expect(result.name).toBe('updated')
      expect('password' in result).toBe(false)
      expect(result.hasPassword).toBe(true)
    })

    it('returns null if connection not found', () => {
      const store = makeStore({
        updateDbConnection: vi.fn(() => null)
      })
      registerDatabaseHandlers(store)

      const handler = handleMock.mock.calls.find(([ch]) => ch === 'database:update')?.[1]
      const event = makeEvent({ isTrusted: true })

      const result = handler?.(event, { id: 'nonexistent', updates: {} })

      expect(result).toBeNull()
    })

    it('rejects untrusted sender', () => {
      const store = makeStore()
      registerDatabaseHandlers(store)

      const handler = handleMock.mock.calls.find(([ch]) => ch === 'database:update')?.[1]
      const event = makeEvent({ isTrusted: false })

      expect(() => handler?.(event, { id: 'id-1', updates: {} })).toThrow('untrusted_sender')
      expect(store.updateDbConnection).not.toHaveBeenCalled()
    })
  })

  describe('database:remove', () => {
    it('calls store.removeDbConnection and returns void', () => {
      const store = makeStore({
        removeDbConnection: vi.fn()
      })
      registerDatabaseHandlers(store)

      const handler = handleMock.mock.calls.find(([ch]) => ch === 'database:remove')?.[1]
      const event = makeEvent({ isTrusted: true })

      const result = handler?.(event, { id: 'id-1' })

      expect(store.removeDbConnection).toHaveBeenCalledWith('id-1')
      expect(result).toBeUndefined()
    })

    it('rejects untrusted sender', () => {
      const store = makeStore()
      registerDatabaseHandlers(store)

      const handler = handleMock.mock.calls.find(([ch]) => ch === 'database:remove')?.[1]
      const event = makeEvent({ isTrusted: false })

      expect(() => handler?.(event, { id: 'id-1' })).toThrow('untrusted_sender')
      expect(store.removeDbConnection).not.toHaveBeenCalled()
    })
  })

  describe('database:encryptionStatus', () => {
    it('returns encryption status from credential store', () => {
      const store = makeStore()
      getDbEncryptionStatusMock.mockReturnValue({
        backend: 'dpapi',
        isStrong: true
      })
      registerDatabaseHandlers(store)

      const handler = handleMock.mock.calls.find(([ch]) => ch === 'database:encryptionStatus')?.[1]
      const event = makeEvent({ isTrusted: true })

      const result = handler?.(event)

      expect(result).toEqual({ backend: 'dpapi', isStrong: true })
    })

    it('rejects untrusted sender', () => {
      const store = makeStore()
      registerDatabaseHandlers(store)

      const handler = handleMock.mock.calls.find(([ch]) => ch === 'database:encryptionStatus')?.[1]
      const event = makeEvent({ isTrusted: false })

      expect(() => handler?.(event)).toThrow('untrusted_sender')
    })
  })

  describe('untrusted sender isolation', () => {
    it('prevents untrusted sender from mutating store', () => {
      const store = makeStore({
        addDbConnection: vi.fn(),
        updateDbConnection: vi.fn(),
        removeDbConnection: vi.fn()
      })
      registerDatabaseHandlers(store)

      const addHandler = handleMock.mock.calls.find(([ch]) => ch === 'database:add')?.[1]
      const updateHandler = handleMock.mock.calls.find(([ch]) => ch === 'database:update')?.[1]
      const removeHandler = handleMock.mock.calls.find(([ch]) => ch === 'database:remove')?.[1]
      const event = makeEvent({ isTrusted: false })

      expect(() => addHandler?.(event, { input: {} })).toThrow('untrusted_sender')
      expect(() => updateHandler?.(event, { id: 'x', updates: {} })).toThrow('untrusted_sender')
      expect(() => removeHandler?.(event, { id: 'x' })).toThrow('untrusted_sender')

      expect(store.addDbConnection).not.toHaveBeenCalled()
      expect(store.updateDbConnection).not.toHaveBeenCalled()
      expect(store.removeDbConnection).not.toHaveBeenCalled()
    })

    it('allows trusted sender to mutate store', () => {
      const addedConn = makeDbConnection()
      const store = makeStore({
        addDbConnection: vi.fn(() => addedConn),
        removeDbConnection: vi.fn()
      })
      registerDatabaseHandlers(store)

      const addHandler = handleMock.mock.calls.find(([ch]) => ch === 'database:add')?.[1]
      const removeHandler = handleMock.mock.calls.find(([ch]) => ch === 'database:remove')?.[1]
      const event = makeEvent({ isTrusted: true })
      const input = makeDbConnection()

      addHandler?.(event, { input })
      removeHandler?.(event, { id: 'id-1' })

      expect(store.addDbConnection).toHaveBeenCalled()
      expect(store.removeDbConnection).toHaveBeenCalledWith('id-1')
    })
  })

  describe('password stripping', () => {
    it('strips password from all summary returns', () => {
      const connWithPassword = makeDbConnection({
        password: 'db.safeStorage.v1:secret'
      })
      const connWithoutPassword = makeDbConnection({
        password: undefined
      })

      const store = makeStore({
        getDbConnections: vi.fn(() => [connWithPassword, connWithoutPassword]),
        addDbConnection: vi.fn(() => connWithPassword),
        updateDbConnection: vi.fn(() => connWithPassword)
      })
      registerDatabaseHandlers(store)

      const listHandler = handleMock.mock.calls.find(([ch]) => ch === 'database:list')?.[1]
      const addHandler = handleMock.mock.calls.find(([ch]) => ch === 'database:add')?.[1]
      const updateHandler = handleMock.mock.calls.find(([ch]) => ch === 'database:update')?.[1]
      const event = makeEvent({ isTrusted: true })
      const validInput: DbConnectionInput = {
        name: 'db',
        engine: 'postgres',
        host: 'localhost',
        port: 5432,
        database: 'db',
        user: 'user'
      }

      const listResult = listHandler?.(event) as DbConnectionSummary[]
      const addResult = addHandler?.(event, { input: validInput }) as DbConnectionSummary
      const updateResult = updateHandler?.(event, { id: 'x', updates: {} }) as DbConnectionSummary

      expect(listResult.every((r) => !('password' in r))).toBe(true)
      expect(!('password' in addResult)).toBe(true)
      expect(!('password' in updateResult)).toBe(true)

      expect(listResult[0].hasPassword).toBe(true)
      expect(listResult[1].hasPassword).toBe(false)
      expect(addResult.hasPassword).toBe(true)
      expect(updateResult.hasPassword).toBe(true)
    })
  })

  describe('lifecycle handlers (test/connect/disconnect/statuses)', () => {
    const trusted = makeEvent({ isTrusted: true })

    function getHandler(channel: string) {
      return handleMock.mock.calls.find(([ch]) => ch === channel)?.[1]
    }

    const formInput: DbConnectionInput = {
      name: 'db',
      engine: 'postgres',
      host: 'db.example.com',
      port: 5432,
      database: 'app',
      user: 'admin',
      password: 'typed-pw'
    }

    it('database:test returns ok and resolves smart-by-host SSL for the config', async () => {
      registerDatabaseHandlers(makeStore())
      const result = await getHandler('database:test')?.(trusted, { input: formInput })
      expect(result).toEqual({ ok: true })
      expect(managerMock.test).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'db-test', ssl: 'verify-full', password: 'typed-pw' })
      )
    })

    it('database:test returns a redacted error and never leaks the DSN/password', async () => {
      registerDatabaseHandlers(makeStore())
      managerMock.test.mockRejectedValueOnce(
        Object.assign(new Error('auth failed postgres://admin:s3cr3t@db:5432/app'), {
          code: '28P01'
        })
      )
      const result = await getHandler('database:test')?.(trusted, { input: formInput })
      expect(result.ok).toBe(false)
      expect(result.error.code).toBe('auth_failed')
      const serialized = JSON.stringify(result)
      expect(serialized).not.toContain('s3cr3t')
      expect(serialized).not.toContain('postgres://')
    })

    it('database:connect decrypts the stored secret and returns connected state', async () => {
      const store = makeStore({
        getDbConnection: vi.fn(() =>
          makeDbConnection({ id: 'conn-1', password: 'db.safeStorage.v1:stored-pw' })
        )
      })
      registerDatabaseHandlers(store)
      const result = await getHandler('database:connect')?.(trusted, { id: 'conn-1' })
      expect(result).toEqual({ id: 'conn-1', status: 'connected' })
      expect(decryptDbSecretMock).toHaveBeenCalledWith('db.safeStorage.v1:stored-pw')
      expect(managerMock.connect).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'conn-1', password: 'stored-pw' })
      )
    })

    it('database:connect returns a redacted error state when the dial fails', async () => {
      const store = makeStore({
        getDbConnection: vi.fn(() => makeDbConnection({ id: 'conn-1' }))
      })
      registerDatabaseHandlers(store)
      managerMock.connect.mockRejectedValueOnce(
        Object.assign(new Error('nope postgres://admin:s3cr3t@db'), { code: 'ECONNREFUSED' })
      )
      const result = await getHandler('database:connect')?.(trusted, { id: 'conn-1' })
      expect(result.status).toBe('error')
      expect(result.error.code).toBe('connection_refused')
      expect(JSON.stringify(result)).not.toContain('s3cr3t')
    })

    it('database:disconnect delegates to the manager', async () => {
      registerDatabaseHandlers(makeStore())
      await getHandler('database:disconnect')?.(trusted, { id: 'conn-1' })
      expect(managerMock.disconnect).toHaveBeenCalledWith('conn-1')
    })

    it('database:statuses returns the manager snapshot', async () => {
      managerMock.getAllStatuses.mockReturnValueOnce([{ id: 'conn-1', status: 'connected' }])
      registerDatabaseHandlers(makeStore())
      const result = await getHandler('database:statuses')?.(trusted)
      expect(result).toEqual([{ id: 'conn-1', status: 'connected' }])
    })

    it('rejects untrusted senders on every lifecycle channel', async () => {
      registerDatabaseHandlers(makeStore())
      const untrusted = makeEvent({ isTrusted: false })
      await expect(getHandler('database:test')?.(untrusted, { input: formInput })).rejects.toThrow(
        'untrusted_sender'
      )
      await expect(getHandler('database:connect')?.(untrusted, { id: 'x' })).rejects.toThrow(
        'untrusted_sender'
      )
      await expect(getHandler('database:disconnect')?.(untrusted, { id: 'x' })).rejects.toThrow(
        'untrusted_sender'
      )
      expect(() => getHandler('database:statuses')?.(untrusted)).toThrow('untrusted_sender')
      expect(managerMock.test).not.toHaveBeenCalled()
      expect(managerMock.connect).not.toHaveBeenCalled()
      expect(managerMock.disconnect).not.toHaveBeenCalled()
    })
  })

  describe('introspection handlers', () => {
    const trusted = makeEvent({ isTrusted: true })
    function getHandler(channel: string) {
      return handleMock.mock.calls.find(([ch]) => ch === channel)?.[1]
    }

    it('database:introspect returns the schema tree', async () => {
      registerDatabaseHandlers(makeStore())
      const result = await getHandler('database:introspect')?.(trusted, { id: 'c1' })
      expect(result).toEqual({ ok: true, tree: { schemas: ['public'], truncated: false } })
      expect(managerMock.introspectSchemas).toHaveBeenCalledWith('c1')
    })

    it('database:introspectSchemaTables returns the table list', async () => {
      registerDatabaseHandlers(makeStore())
      const result = await getHandler('database:introspectSchemaTables')?.(trusted, {
        id: 'c1',
        schema: 'public'
      })
      expect(result.ok).toBe(true)
      expect(managerMock.introspectTables).toHaveBeenCalledWith('c1', 'public')
    })

    it('database:introspectTableColumns returns columns', async () => {
      registerDatabaseHandlers(makeStore())
      const result = await getHandler('database:introspectTableColumns')?.(trusted, {
        id: 'c1',
        ref: { schema: 'public', table: 'users' }
      })
      expect(result.ok).toBe(true)
      expect(managerMock.introspectColumns).toHaveBeenCalledWith('c1', {
        schema: 'public',
        table: 'users'
      })
    })

    it('returns a redacted error (never a raw throw) when introspection fails', async () => {
      registerDatabaseHandlers(makeStore())
      managerMock.introspectSchemas.mockRejectedValueOnce(
        Object.assign(new Error('boom postgres://admin:s3cr3t@db'), { code: 'ECONNRESET' })
      )
      const result = await getHandler('database:introspect')?.(trusted, { id: 'c1' })
      expect(result.ok).toBe(false)
      expect(result.error.code).toBe('connection_refused')
      expect(JSON.stringify(result)).not.toContain('s3cr3t')
    })

    it('rejects untrusted senders on introspection channels', async () => {
      registerDatabaseHandlers(makeStore())
      const untrusted = makeEvent({ isTrusted: false })
      await expect(getHandler('database:introspect')?.(untrusted, { id: 'c1' })).rejects.toThrow(
        'untrusted_sender'
      )
      expect(managerMock.introspectSchemas).not.toHaveBeenCalled()
    })
  })

  describe('query handlers', () => {
    const trusted = makeEvent({ isTrusted: true })
    function getHandler(channel: string) {
      return handleMock.mock.calls.find(([ch]) => ch === channel)?.[1]
    }

    it('derives allowWrite=false from a read-only stored connection', async () => {
      const store = makeStore({
        getDbConnection: vi.fn(() => makeDbConnection({ id: 'c1', readOnly: true }))
      })
      registerDatabaseHandlers(store)
      await getHandler('database:query')?.(trusted, { id: 'c1', sql: 'SELECT 1' })
      expect(managerMock.query).toHaveBeenCalledWith(
        'c1',
        'SELECT 1',
        expect.objectContaining({ allowWrite: false })
      )
    })

    it('derives allowWrite=true from a writable stored connection', async () => {
      const store = makeStore({
        getDbConnection: vi.fn(() => makeDbConnection({ id: 'c1', readOnly: false }))
      })
      registerDatabaseHandlers(store)
      await getHandler('database:query')?.(trusted, { id: 'c1', sql: 'SELECT 1' })
      expect(managerMock.query).toHaveBeenCalledWith(
        'c1',
        'SELECT 1',
        expect.objectContaining({ allowWrite: true })
      )
    })

    it('ignores any allowWrite the renderer tries to send (server uses readOnly)', async () => {
      const store = makeStore({
        getDbConnection: vi.fn(() => makeDbConnection({ id: 'c1', readOnly: true }))
      })
      registerDatabaseHandlers(store)
      // Renderer attempts to force writes; handler must not honor it.
      await getHandler('database:query')?.(trusted, {
        id: 'c1',
        sql: 'DROP TABLE x',
        allowWrite: true
      })
      expect(managerMock.query).toHaveBeenCalledWith(
        'c1',
        'DROP TABLE x',
        expect.objectContaining({ allowWrite: false })
      )
    })

    it('treats a missing connection as read-only', async () => {
      const store = makeStore({ getDbConnection: vi.fn(() => undefined) })
      registerDatabaseHandlers(store)
      await getHandler('database:query')?.(trusted, { id: 'missing', sql: 'SELECT 1' })
      expect(managerMock.query).toHaveBeenCalledWith(
        'missing',
        'SELECT 1',
        expect.objectContaining({ allowWrite: false })
      )
    })

    it('returns a redacted error when the query fails', async () => {
      const store = makeStore({
        getDbConnection: vi.fn(() => makeDbConnection({ id: 'c1' }))
      })
      registerDatabaseHandlers(store)
      managerMock.query.mockRejectedValueOnce(
        Object.assign(new Error('boom postgres://admin:s3cr3t@db'), { code: 'ECONNRESET' })
      )
      const result = await getHandler('database:query')?.(trusted, { id: 'c1', sql: 'SELECT 1' })
      expect(result.ok).toBe(false)
      expect(JSON.stringify(result)).not.toContain('s3cr3t')
    })

    it('cancelQuery delegates to the manager and rejects untrusted senders', async () => {
      registerDatabaseHandlers(makeStore())
      await getHandler('database:cancelQuery')?.(trusted, { id: 'c1' })
      expect(managerMock.cancelQuery).toHaveBeenCalledWith('c1')

      const untrusted = makeEvent({ isTrusted: false })
      await expect(getHandler('database:query')?.(untrusted, { id: 'c1', sql: 'x' })).rejects.toThrow(
        'untrusted_sender'
      )
    })
  })
})

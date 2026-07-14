import { describe, expect, it, vi } from 'vitest'
import type { DatabaseConnectionRequest, DatabaseQueryRequest } from '../../shared/database-types'
import type { DatabaseProvider } from './database-provider'
import { DatabaseService } from './database-service'

const connectionRequest: DatabaseConnectionRequest = {
  connection: {
    providerId: 'postgres',
    host: 'db.internal',
    port: 5432,
    database: 'app',
    user: 'developer',
    sslMode: 'require'
  },
  credential: { password: 'memory-only' }
}

function createProvider(): DatabaseProvider {
  return {
    id: 'postgres',
    testConnection: vi.fn().mockResolvedValue({ database: 'app', serverVersion: '17.1' }),
    introspect: vi.fn().mockResolvedValue({ tables: [] }),
    catalog: vi.fn().mockResolvedValue({
      databases: ['app'],
      schemas: ['public'],
      currentDatabase: 'app',
      currentSchema: 'public'
    }),
    execute: vi.fn().mockResolvedValue({
      columns: [],
      rows: [],
      command: 'SELECT',
      rowCount: 0,
      truncated: false,
      durationMs: 4
    }),
    cancel: vi.fn().mockResolvedValue(true)
  }
}

describe('DatabaseService', () => {
  it('routes connection and schema requests through the provider registry', async () => {
    const provider = createProvider()
    const service = new DatabaseService([provider])
    const signal = new AbortController().signal

    await expect(service.testConnection(connectionRequest, signal)).resolves.toEqual({
      database: 'app',
      serverVersion: '17.1'
    })
    await expect(service.introspect(connectionRequest, signal)).resolves.toEqual({ tables: [] })
    await expect(service.catalog(connectionRequest, signal)).resolves.toMatchObject({
      currentDatabase: 'app',
      currentSchema: 'public'
    })
    expect(provider.testConnection).toHaveBeenCalledWith(connectionRequest, signal)
    expect(provider.introspect).toHaveBeenCalledWith(connectionRequest, signal)
    expect(provider.catalog).toHaveBeenCalledWith(connectionRequest, signal)
  })

  it('routes execute and cancel to the selected provider', async () => {
    const provider = createProvider()
    const service = new DatabaseService([provider])
    const request: DatabaseQueryRequest = {
      ...connectionRequest,
      queryId: 'query-1',
      sql: 'SELECT 1',
      readOnly: true,
      maxRows: 500,
      timeoutMs: 30_000
    }

    await service.execute(request)
    await expect(service.cancel('postgres', 'query-1')).resolves.toBe(true)
    expect(provider.execute).toHaveBeenCalledWith(request, undefined)
    expect(provider.cancel).toHaveBeenCalledWith('query-1')
  })

  it('uses and closes the project SSH route around database operations', async () => {
    const provider = createProvider()
    const close = vi.fn().mockResolvedValue(undefined)
    const sshConnectionRoute = {
      open: vi.fn().mockResolvedValue({
        connection: {
          ...connectionRequest.connection,
          host: '127.0.0.1',
          port: 45_678,
          tlsServerName: 'db.internal'
        },
        close
      })
    }
    const service = new DatabaseService([provider], sshConnectionRoute as never)
    const sshRequest: DatabaseConnectionRequest = {
      ...connectionRequest,
      execution: { kind: 'ssh', connectionId: 'ssh-p8' }
    }

    await service.testConnection(sshRequest)

    expect(provider.testConnection).toHaveBeenCalledWith(
      {
        ...sshRequest,
        connection: {
          ...connectionRequest.connection,
          host: '127.0.0.1',
          port: 45_678,
          tlsServerName: 'db.internal'
        }
      },
      undefined
    )
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('closes the project SSH route when the provider rejects', async () => {
    const provider = createProvider()
    vi.mocked(provider.execute).mockRejectedValueOnce(new Error('query failed'))
    const close = vi.fn().mockResolvedValue(undefined)
    const service = new DatabaseService([provider], {
      open: vi.fn().mockResolvedValue({ connection: connectionRequest.connection, close })
    } as never)
    const request: DatabaseQueryRequest = {
      ...connectionRequest,
      execution: { kind: 'ssh', connectionId: 'ssh-p8' },
      queryId: 'query-failure',
      sql: 'SELECT broken',
      readOnly: true,
      maxRows: 500,
      timeoutMs: 30_000
    }

    await expect(service.execute(request)).rejects.toThrow('query failed')
    expect(close).toHaveBeenCalledTimes(1)
  })
})

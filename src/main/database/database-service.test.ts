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
    expect(provider.testConnection).toHaveBeenCalledWith(connectionRequest, signal)
    expect(provider.introspect).toHaveBeenCalledWith(connectionRequest, signal)
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
})

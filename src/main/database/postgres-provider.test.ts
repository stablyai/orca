import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DatabaseQueryRequest } from '../../shared/database-types'

const postgres = vi.hoisted(() => ({
  clientConfigs: [] as unknown[],
  clients: [] as {
    processID: number
    connect: ReturnType<typeof vi.fn>
    end: ReturnType<typeof vi.fn>
    queries: unknown[]
    query: ReturnType<typeof vi.fn>
  }[],
  cursorRows: [] as unknown[][],
  cursorError: null as Error | null,
  cursorReadSizes: [] as number[],
  deferCursorRead: false,
  cursorReadCallback: null as
    | ((error: Error | null, rows: unknown[][], result: unknown) => void)
    | null
}))

vi.mock('pg', () => ({
  Client: class MockClient {
    readonly processID: number
    readonly connect = vi.fn(async () => {})
    readonly end = vi.fn(async () => {})
    readonly queries: unknown[] = []
    readonly query = vi.fn((query: unknown) => {
      this.queries.push(query)
      if (typeof query !== 'string') {
        return query
      }
      if (query.startsWith('SELECT current_database()')) {
        return Promise.resolve({ rows: [{ database: 'app', server_version: '17.2' }] })
      }
      if (query.startsWith('SELECT pg_cancel_backend')) {
        return Promise.resolve({ rows: [{ canceled: true }] })
      }
      return Promise.resolve({ rows: [], fields: [], command: 'OK', rowCount: null })
    })

    constructor(config: unknown) {
      this.processID = 1000 + postgres.clients.length
      postgres.clientConfigs.push(config)
      postgres.clients.push(this)
    }
  }
}))

vi.mock('pg-cursor', () => ({
  default: class MockCursor {
    readonly close = vi.fn(async () => {})

    read(
      size: number,
      callback: (error: Error | null, rows: unknown[][], result: unknown) => void
    ): void {
      postgres.cursorReadSizes.push(size)
      const complete = (error: Error | null = postgres.cursorError) =>
        callback(error, postgres.cursorRows.slice(0, size), {
          fields: [{ name: 'value', dataTypeID: 23 }],
          command: 'SELECT',
          rowCount: postgres.cursorRows.length
        })
      if (postgres.deferCursorRead) {
        postgres.cursorReadCallback = complete
        return
      }
      complete()
    }
  }
}))

import { PostgresProvider } from './postgres-provider'

const request: DatabaseQueryRequest = {
  connection: {
    providerId: 'postgres',
    host: 'db.internal',
    port: 5432,
    database: 'app',
    user: 'developer',
    sslMode: 'require'
  },
  credential: { password: '  significant whitespace  ' },
  queryId: 'query-1',
  sql: 'SELECT value FROM sample',
  readOnly: true,
  maxRows: 2,
  timeoutMs: 5_000
}

describe('PostgresProvider', () => {
  beforeEach(() => {
    postgres.clientConfigs.length = 0
    postgres.clients.length = 0
    postgres.cursorRows = []
    postgres.cursorError = null
    postgres.cursorReadSizes.length = 0
    postgres.deferCursorRead = false
    postgres.cursorReadCallback = null
  })

  it('preserves password bytes and applies the requested TLS mode', async () => {
    const provider = new PostgresProvider()

    await expect(provider.testConnection(request)).resolves.toEqual({
      database: 'app',
      serverVersion: '17.2'
    })
    expect(postgres.clientConfigs[0]).toMatchObject({
      password: '  significant whitespace  ',
      ssl: { rejectUnauthorized: false }
    })
  })

  it('preserves the database TLS identity across a loopback SSH tunnel', async () => {
    const provider = new PostgresProvider()

    await provider.testConnection({
      ...request,
      connection: {
        ...request.connection,
        host: '127.0.0.1',
        port: 45_678,
        sslMode: 'verify-full',
        tlsServerName: 'db.internal'
      }
    })

    expect(postgres.clientConfigs[0]).toMatchObject({
      host: '127.0.0.1',
      port: 45_678,
      ssl: { rejectUnauthorized: true, servername: 'db.internal' }
    })
  })

  it('runs read-only queries in a bounded transaction and reports truncation', async () => {
    postgres.cursorRows = [[1], [2], [3]]
    const provider = new PostgresProvider()

    await expect(provider.execute(request)).resolves.toMatchObject({
      columns: [{ name: 'value', dataTypeId: 23 }],
      rows: [[1], [2]],
      command: 'SELECT',
      rowCount: 3,
      truncated: true
    })
    expect(postgres.cursorReadSizes).toEqual([3])
    expect(postgres.clients[0]?.queries).toEqual(
      expect.arrayContaining(['BEGIN READ ONLY', 'SET LOCAL statement_timeout = 5000', 'COMMIT'])
    )
  })

  it('rolls back when cursor execution fails', async () => {
    postgres.cursorError = new Error('query failed')
    const provider = new PostgresProvider()

    await expect(provider.execute(request)).rejects.toThrow('query failed')
    expect(postgres.clients[0]?.queries).toContain('ROLLBACK')
  })

  it('cancels a busy cursor through a separate backend connection', async () => {
    postgres.deferCursorRead = true
    const provider = new PostgresProvider()
    const execution = provider.execute(request)
    await vi.waitFor(() => expect(postgres.cursorReadCallback).not.toBeNull())

    await expect(provider.cancel(request.queryId)).resolves.toBe(true)
    expect(postgres.clients).toHaveLength(2)
    expect(postgres.clientConfigs[1]).toMatchObject({
      connectionTimeoutMillis: 5_000,
      application_name: 'orca-database-tab-cancel'
    })
    expect(postgres.clients[1]?.query).toHaveBeenCalledWith(
      'SELECT pg_cancel_backend($1) AS canceled',
      [1000]
    )

    postgres.cursorReadCallback?.(new Error('canceling statement'), [], {})
    await expect(execution).rejects.toThrow('canceling statement')
  })
})

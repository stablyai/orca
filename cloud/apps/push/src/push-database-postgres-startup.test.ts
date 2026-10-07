import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'

const fakes = vi.hoisted(() => ({
  configs: [] as Array<Record<string, unknown>>,
  lifecycle: [] as string[],
  query: vi.fn(async (_sql: string) => ({ rows: [], rowCount: 0 })),
  release: vi.fn()
}))

vi.mock('pg', () => ({
  default: {
    Pool: class {
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
      }
    }
  }
}))

import { openPushDatabase } from './push-database.js'
import { pushSchemaStatements } from './push-schema.js'

describe('PostgreSQL push gateway startup', () => {
  beforeEach(() => {
    fakes.configs.length = 0
    fakes.lifecycle.length = 0
    fakes.query.mockClear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  const socketPassword = `${randomUUID()}@/`
  const socketUrl = `postgresql://push:${encodeURIComponent(socketPassword)}@/orca_push?host=/cloudsql/test:region:instance`

  it('passes the Terraform socket URL unchanged to both active pools', async () => {
    const database = await openPushDatabase({ databaseUrl: socketUrl, dataDir: '/unused' })
    expect(fakes.configs.map((config) => config.connectionString)).toEqual([socketUrl, socketUrl])
    await database.close()
  })

  it('parses socket credentials and query options before enforcing validation read-only', async () => {
    const options = '-c search_path=validation -c default_transaction_read_only=off'
    const database = await openPushDatabase({
      databaseUrl: `${socketUrl}&port=5433&sslmode=disable&options=${encodeURIComponent(options)}`,
      dataDir: '/unused',
      readOnly: true
    })
    expect(fakes.configs).toHaveLength(1)
    expect(fakes.configs[0]).toMatchObject({
      host: '/cloudsql/test:region:instance',
      user: 'push',
      password: socketPassword,
      database: 'orca_push',
      port: 5433,
      ssl: false,
      options: `${options} -c default_transaction_read_only=on`
    })
    expect(fakes.configs[0]).not.toHaveProperty('connectionString')
    expect(fakes.query).not.toHaveBeenCalled()
    await database.close()
  })

  // Why: a CREATE INDEX on a grown table can outlive the 5s request deadline,
  // and a schema that inherits it fails every startup at the same statement.
  it('applies the schema on an untimed pool that is gone before the serving pool opens', async () => {
    const database = await openPushDatabase({
      databaseUrl: 'postgresql://push@localhost:55440/orca_push',
      dataDir: '/unused',
      poolMax: 2,
      applicationName: 'orca-push'
    })
    expect(fakes.lifecycle).toEqual([
      'open max=1 statement_timeout=0',
      'end max=1 statement_timeout=0',
      'open max=2 statement_timeout=5000'
    ])
    expect(fakes.configs[0]).toMatchObject({
      application_name: 'orca-push/schema',
      lock_timeout: 1_000,
      idle_in_transaction_session_timeout: 5_000
    })
    expect(
      fakes.query.mock.calls.map(([sql]) => sql).slice(0, pushSchemaStatements().length)
    ).toEqual(pushSchemaStatements())
    await database.close()
  })

  it('retries a transaction the pool statement_timeout aborted', async () => {
    const database = await openPushDatabase({
      databaseUrl: 'postgresql://push@localhost:55440/orca_push',
      dataDir: '/unused'
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    let attempts = 0
    const result = await database.transaction(async () => {
      attempts += 1
      if (attempts === 1) throw Object.assign(new Error('canceling statement'), { code: '57014' })
      return 'done'
    })
    expect(result).toBe('done')
    expect(attempts).toBe(2)
    expect(warn.mock.calls.map(([line]) => String(line))).toEqual([
      expect.stringContaining('"code":"57014"')
    ])
    warn.mockRestore()
    await database.close()
  })
})

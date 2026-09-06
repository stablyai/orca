import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
    expect(fakes.query.mock.calls.map(([sql]) => sql)).toEqual(pushSchemaStatements())
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

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { openRelayDatabase, type RelayDatabase } from './database.js'

const databaseUrl = process.env.ORCA_RELAY_TEST_POSTGRES_URL
const describePostgres = databaseUrl ? describe : describe.skip

describePostgres('real PostgreSQL query failure phases', () => {
  let database: RelayDatabase

  beforeAll(async () => {
    database = await openRelayDatabase({
      databaseUrl,
      dataDir: '',
      poolMax: 1,
      statementTimeoutMs: 50
    })
  })
  afterAll(async () => {
    await database.close()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('distinguishes a server statement timeout and leaves the pool usable', async () => {
    const log = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await expect(database.query('SELECT pg_sleep(0.2)')).rejects.toMatchObject({ code: '57014' })
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toMatchObject({
      event: 'orca_relay_postgres_query_failed',
      phase: 'execute',
      code: '57014',
      connectionTimeout: false
    })
    expect(await database.query('SELECT 1 AS ok')).toEqual([{ ok: 1 }])
  })

  it('distinguishes queue acquisition timeout without running the statement', async () => {
    const log = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    let acquired!: () => void
    const ready = new Promise<void>((resolve) => {
      acquired = resolve
    })
    let release!: () => void
    const wait = new Promise<void>((resolve) => {
      release = resolve
    })
    const holder = database.transaction(async () => {
      acquired()
      await wait
    })
    await ready
    try {
      await expect(database.query('SELECT pg_sleep(0.2)')).rejects.toThrow(
        'timeout exceeded when trying to connect'
      )
      expect(JSON.parse(log.mock.calls[0]![0] as string)).toMatchObject({
        event: 'orca_relay_postgres_query_failed',
        phase: 'acquire',
        code: 'unknown',
        connectionTimeout: true,
        poolTotal: 1,
        poolIdle: 0
      })
    } finally {
      release()
      await holder
    }
    expect(await database.query('SELECT 1 AS ok')).toEqual([{ ok: 1 }])
  })
})

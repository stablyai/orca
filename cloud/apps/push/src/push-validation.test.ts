import { expect, it, vi } from 'vitest'
import { loadPushConfig } from './config.js'
import { openPushDatabase } from './push-database.js'
import { createPushServer } from './push-server.js'
import { startPushBackground } from './push-background.js'

it('fails closed on an invalid validation mode', () => {
  for (const mode of ['typo', '', ' ']) {
    expect(() =>
      loadPushConfig({ ORCA_PUSH_PUBLIC_URL: 'https://push.onorca.dev', ORCA_PUSH_MODE: mode })
    ).toThrow()
  }
})

const databaseUrl = process.env.ORCA_PUSH_TEST_DATABASE_URL
it.skipIf(!databaseUrl)(
  'validation cannot write PostgreSQL and starts no consumers or pruners',
  async () => {
    if (!process.env.CI && new URL(databaseUrl!).port !== '55440')
      throw new Error('isolated_postgres_port_required')
    const active = await openPushDatabase({ databaseUrl, dataDir: '' })
    const schema = `validation_${Date.now()}`
    await active.query(`CREATE SCHEMA ${schema}`)
    const isolatedUrl = new URL(databaseUrl!)
    isolatedUrl.searchParams.set(
      'options',
      `-c search_path=${schema} -c default_transaction_read_only=off`
    )
    isolatedUrl.searchParams.set('host', isolatedUrl.hostname)
    isolatedUrl.searchParams.set('port', isolatedUrl.port)
    const hostlessUrl = `postgresql://${isolatedUrl.username}:${isolatedUrl.password}@${isolatedUrl.pathname}?${isolatedUrl.searchParams}`
    const database = await openPushDatabase({
      databaseUrl: hostlessUrl,
      dataDir: '',
      readOnly: true
    })
    const config = loadPushConfig({
      ORCA_PUSH_PUBLIC_URL: 'https://push.onorca.dev',
      ORCA_PUSH_MODE: 'validation'
    })
    const runtime = createPushServer(config, database)
    let stop: (() => Promise<void>) | undefined
    try {
      const [setting] = await database.query(
        "SELECT current_setting('default_transaction_read_only') AS default_transaction_read_only"
      )
      expect(setting!.default_transaction_read_only).toBe('on')
      await expect(
        database.query(`CREATE TABLE ${schema}.forbidden (id integer)`)
      ).rejects.toMatchObject({ code: '25006' })
      // An empty schema stays empty: validation must not run startup DDL.
      expect(
        await active.query('SELECT tablename FROM pg_tables WHERE schemaname = ?', [schema])
      ).toEqual([])
      const calls = vi.spyOn(database, 'query')
      const claim = vi.spyOn(runtime.deliveryStore, 'claim')
      const send = vi.spyOn(runtime.worker, 'start')
      vi.useFakeTimers()
      stop = startPushBackground(config, runtime)
      await vi.advanceTimersByTimeAsync(31 * 60_000)
      expect(calls).not.toHaveBeenCalled()
      expect(claim).not.toHaveBeenCalled()
      expect(send).not.toHaveBeenCalled()
      vi.useRealTimers()
      expect(await (await runtime.app.request('/health')).json()).toMatchObject({
        mode: 'validation'
      })
      expect((await runtime.app.request('/ready')).status).toBe(200)
      expect((await runtime.app.request('/v1/host/challenge', { method: 'POST' })).status).toBe(503)
      expect((await runtime.app.request('/v1/send', { method: 'POST' })).status).toBe(503)
      expect(calls.mock.calls.map(([sql]) => sql)).toEqual(['SELECT 1 AS ready'])
      await expect(
        database.query('DELETE FROM public.push_challenges WHERE false')
      ).rejects.toMatchObject({ code: '25006' })
    } finally {
      vi.useRealTimers()
      await stop?.()
      runtime.closeTransports()
      await database.close()
      await active.query(`DROP SCHEMA ${schema} CASCADE`)
      await active.close()
      vi.restoreAllMocks()
    }
  }
)

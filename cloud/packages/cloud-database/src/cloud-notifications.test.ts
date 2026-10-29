import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { openCloudDatabase, openInMemoryCloudDatabase } from './cloud-database.js'
import { openCloudNotifications } from './cloud-notifications.js'

const postgresUrl = process.env.ORCA_CLOUD_DATABASE_TEST_URL

function collector() {
  const payloads: string[] = []
  let reconnects = 0
  let wake: (() => void) | null = null
  return {
    payloads,
    reconnects: () => reconnects,
    handlers: {
      onNotify: (payload: string) => {
        payloads.push(payload)
        wake?.()
      },
      onReconnect: () => {
        reconnects++
        wake?.()
      }
    },
    until: async (done: () => boolean, timeoutMs = 10_000) => {
      const deadline = Date.now() + timeoutMs
      while (!done()) {
        if (Date.now() > deadline) {
          throw new Error('timed out')
        }
        await new Promise<void>((resolve) => {
          wake = resolve
          setTimeout(resolve, 50)
        })
      }
    }
  }
}

describe('cloud database notifications', () => {
  it('wakes SQLite listeners in this process', async () => {
    const database = await openInMemoryCloudDatabase([])
    const notifications = openCloudNotifications({})
    const seen = collector()
    const stop = await notifications.listen('inbox', seen.handlers)
    await database.transaction((tx) => notifications.notify(tx, 'inbox', 'host-1'))
    await stop()
    await notifications.notify(database, 'inbox', 'host-2')
    expect(seen.payloads).toEqual(['host-1'])
    await database.close()
  })

  it('refuses a channel that is not a plain identifier', async () => {
    const database = await openInMemoryCloudDatabase([])
    await expect(
      openCloudNotifications({}).notify(database, 'inbox; DROP', 'x')
    ).rejects.toThrow('invalid_listen_channel')
    await database.close()
  })

  it.skipIf(!postgresUrl)(
    'delivers a Postgres notification at commit and re-listens after losing its connection',
    async () => {
      const applicationName = `cloud-db-listen-${randomUUID()}`
      const database = await openCloudDatabase({
        service: 'test',
        schemaStatements: [],
        databaseUrl: postgresUrl,
        dataDir: '',
        applicationName
      })
      const notifications = openCloudNotifications({ databaseUrl: postgresUrl, applicationName })
      const seen = collector()
      const stop = await notifications.listen('inbox', seen.handlers)
      try {
        await database.transaction(async (tx) => {
          await notifications.notify(tx, 'inbox', 'committed')
          await new Promise((resolve) => setTimeout(resolve, 100))
          expect(seen.payloads).toEqual([])
        })
        await seen.until(() => seen.payloads.length === 1)

        await database.query(
          'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = ?',
          [`${applicationName}/listen`]
        )
        await seen.until(() => seen.reconnects() === 1)
        await notifications.notify(database, 'inbox', 'after-reconnect')
        await seen.until(() => seen.payloads.length === 2)
        expect(seen.payloads).toEqual(['committed', 'after-reconnect'])
      } finally {
        await stop()
        await database.close()
      }
    }
  )
})

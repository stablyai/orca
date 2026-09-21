import { expect, it, vi } from 'vitest'
import { openPushDatabase, type PushDatabase } from './push-database.js'
import { PushDeviceRegistryStore } from './device-registry-store.js'

const databaseUrl = process.env.ORCA_PUSH_TEST_DATABASE_URL
it.skipIf(!databaseUrl)(
  'serializes deletion with a registration that has already read its row',
  async () => {
    if (!process.env.CI && new URL(databaseUrl!).port !== '55440')
      throw new Error('isolated_postgres_port_required')
    const database = await openPushDatabase({
      databaseUrl,
      dataDir: '',
      poolMax: 4,
      applicationName: 'push-delete-race'
    })
    let release!: () => void
    const paused = new Promise<void>((resolve) => {
      release = resolve
    })
    let read = false
    let pause = false
    const wrapped: PushDatabase = {
      dialect: database.dialect,
      query: database.query.bind(database),
      close: database.close.bind(database),
      lockQuotaScope: database.lockQuotaScope.bind(database),
      transaction: (run) =>
        database.transaction((tx) =>
          run({
            dialect: tx.dialect,
            close: tx.close.bind(tx),
            transaction: tx.transaction.bind(tx),
            lockQuotaScope: tx.lockQuotaScope.bind(tx),
            query: async (sql, params) => {
              const rows = await tx.query(sql, params)
              if (pause && sql.startsWith('SELECT registration_id FROM push_devices')) {
                read = true
                await paused
              }
              return rows
            }
          })
        )
    }
    const devices = new PushDeviceRegistryStore(wrapped)
    const input = {
      hostFingerprint: 'delete-race-host',
      deviceId: 'phone',
      platform: 'android' as const,
      token: 'synthetic'
    }
    let registration: Promise<unknown> | undefined
    let deletion: Promise<boolean> | undefined
    try {
      await database.query('DELETE FROM push_devices WHERE host_fingerprint = ?', [
        input.hostFingerprint
      ])
      const first = await devices.upsert(input)
      if (!first.ok) throw new Error('registration refused')
      pause = true
      registration = devices.upsert(input)
      await vi.waitFor(() => expect(read).toBe(true))
      let deleted = false
      deletion = devices.deleteOwned(input.hostFingerprint, first.registrationId).then((value) => {
        deleted = true
        return value
      })
      await vi.waitFor(async () => {
        const rows = await database.query(
          "SELECT 1 FROM pg_stat_activity WHERE application_name = 'push-delete-race' AND wait_event_type = 'Lock'"
        )
        expect(deleted || rows.length > 0).toBe(true)
      })
      expect(deleted).toBe(false)
      release()
      expect(await registration).toEqual(first)
      expect(await deletion).toBe(true)
    } finally {
      release()
      await Promise.allSettled([registration, deletion])
      await database.query('DELETE FROM push_devices WHERE host_fingerprint = ?', [
        input.hostFingerprint
      ])
      await database.close()
    }
  }
)

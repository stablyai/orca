import { expect, it } from 'vitest'
import type { PushDatabase } from './push-database.js'
import { reserveRequestConnection } from './push-background-database.js'
import { createPushServer } from './push-server.js'
import { testPushConfig } from './push-server-harness.test-fixture.js'

function concurrencyProbe() {
  let active = 0
  let peak = 0
  const hold = async <T>(value: T): Promise<T> => {
    peak = Math.max(peak, ++active)
    await new Promise((resolve) => setTimeout(resolve, 5))
    active--
    return value
  }
  const database: PushDatabase = {
    dialect: 'postgres',
    query: () => hold([]),
    transaction: (operation) => hold(undefined).then(() => operation(database)),
    lockQuotaScope: async () => undefined,
    tryLockScope: async () => true,
    tryLockSharedScope: async () => true,
    close: async () => undefined
  }
  return { database, peak: () => peak }
}

it.each([
  [2, 1],
  [10, 9],
  [1, 1]
])('lets background work hold at most poolMax - 1 of %i connections', async (poolMax, cap) => {
  const probe = concurrencyProbe()
  const background = reserveRequestConnection(probe.database, poolMax)
  await Promise.all(
    Array.from({ length: 12 }, (_, index) =>
      index % 2 ? background.query('SELECT 1') : background.transaction(async () => undefined)
    )
  )
  expect(probe.peak()).toBe(cap)
})

it('caps the server worker at poolMax - 1 connections', async () => {
  const probe = concurrencyProbe()
  const server = createPushServer({ ...testPushConfig(), databasePoolMax: 3 }, probe.database, {
    fcmAccessToken: async () => 'token',
    fcmTransport: async () => ({ status: 200, body: '{}' })
  })
  try {
    await server.worker.runDue()
  } finally {
    await server.worker.stop()
  }
  expect(probe.peak()).toBe(2)
})

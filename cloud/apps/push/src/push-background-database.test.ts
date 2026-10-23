import { expect, it } from 'vitest'
import type { PushDatabase } from './push-database.js'
import { reserveRequestConnection } from './push-background-database.js'
import { createPushServer } from './push-server.js'
import { testPushConfig } from './push-server-harness.test-fixture.js'

function concurrencyProbe(capacity: number) {
  let active = 0
  let peak = 0
  const reached = Promise.withResolvers<void>()
  const released = Promise.withResolvers<void>()
  const hold = async <T>(value: T): Promise<T> => {
    peak = Math.max(peak, ++active)
    if (active === capacity) {
      reached.resolve()
    }
    await released.promise
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
  return { database, peak: () => peak, reached: reached.promise, release: released.resolve }
}

it.each([
  [2, 1],
  [10, 9],
  [1, 1]
])('lets background work hold at most poolMax - 1 of %i connections', async (poolMax, cap) => {
  const probe = concurrencyProbe(cap)
  const background = reserveRequestConnection(probe.database, poolMax)
  const pending = Promise.all(
    Array.from({ length: 12 }, (_, index) =>
      index % 2 ? background.query('SELECT 1') : background.transaction(async () => undefined)
    )
  )
  await probe.reached
  probe.release()
  await pending
  expect(probe.peak()).toBe(cap)
})

it('bounds server claims before they enter the background pool', async () => {
  const probe = concurrencyProbe(3)
  const server = createPushServer({ ...testPushConfig(), databasePoolMax: 6 }, probe.database, {
    fcmAccessToken: async () => 'token',
    fcmTransport: async () => ({ status: 200, body: '{}' })
  })
  const pending = server.worker.runDue()
  try {
    await probe.reached
    probe.release()
    await pending
  } finally {
    probe.release()
    await server.worker.stop()
  }
  expect(probe.peak()).toBe(3)
})

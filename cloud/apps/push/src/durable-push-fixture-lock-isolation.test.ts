import { afterEach, expect, it } from 'vitest'
import { DurablePushStore } from './durable-push-store.js'
import {
  cleanupDurablePushFixtures,
  DEVICE_HEAD_SQL,
  durablePushTestDatabaseUrl,
  fixture,
  notification,
  pauseAfter,
  within
} from './durable-push-store.test-fixture.js'

afterEach(cleanupDurablePushFixtures)

it.skipIf(!durablePushTestDatabaseUrl)(
  'claims the same device in another schema while a fixture holds its device lock',
  async () => {
    const first = await fixture()
    const second = await fixture()
    const [firstScope] = await first.db.query(
      'SELECT current_database() AS database, current_schema() AS schema'
    )
    const [secondScope] = await second.db.query(
      'SELECT current_database() AS database, current_schema() AS schema'
    )
    expect(firstScope?.database).toBe(secondScope?.database)
    expect(firstScope?.schema).not.toBe(secondScope?.schema)
    await first.store.accept('host', 'phone', notification(1))
    await second.store.accept('host', 'phone', notification(2))
    const paused = pauseAfter(first.db, DEVICE_HEAD_SQL)
    const held = new DurablePushStore(paused.wrapped, first.clock).claim()
    await paused.atCandidate
    try {
      expect(await within(first.store.claim(), 2_000)).toBeNull()
      expect((await within(second.store.claim(), 2_000))?.notification.notificationSeq).toBe(2)
    } finally {
      paused.release()
      await held
    }
    expect((await held)?.notification.notificationSeq).toBe(1)
  }
)

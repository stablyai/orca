import { afterEach, expect, it, vi } from 'vitest'
import type { PushNotification } from '@orca-cloud/push-contract/send-messages'
import { DurablePushStore } from './durable-push-store.js'
import { DurablePushWorker } from './durable-push-worker.js'
import { PushDispatcher } from './push-dispatcher.js'
import { PushDeviceRegistryStore } from '../devices/device-registry-store.js'
import { openInMemoryPushDatabase } from '../database/push-database.js'
import type { PushDelivery } from './push-delivery-message.js'
import type { PushProviderOutcome } from '../providers/push-provider-outcome.js'

import { pauseAfter, within } from './durable-push-store.test-fixture.js'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
  vi.restoreAllMocks()
})
const note = (seq: number, overrides: Partial<PushNotification> = {}): PushNotification => ({
  notificationId: `note-${seq}`,
  notificationSeq: seq,
  notificationEpoch: 'epoch',
  source: 'agent-task-complete',
  agentState: 'finished',
  title: 'Done',
  body: 'Finished task',
  ...overrides
})
async function fixture() {
  const db = await openInMemoryPushDatabase()
  let time = 1_000_000
  const now = () => time
  const store = new DurablePushStore(db, now)
  const devices = new PushDeviceRegistryStore(db, now)
  const device = await devices.upsert({
    hostFingerprint: 'host',
    deviceId: 'phone',
    platform: 'android',
    token: 'test-token'
  })
  if (!device.ok) throw new Error('registration failed')
  const send = vi.fn(async (_delivery: PushDelivery): Promise<PushProviderOutcome> => ({
    status: 'sent'
  }))
  const dispatcher = new PushDispatcher({ devices, fcm: { send } as never })
  const worker = new DurablePushWorker(store, dispatcher, { now })
  cleanups.push(async () => {
    await worker.stop()
    await db.close()
  })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  return {
    db,
    store,
    devices,
    worker,
    dispatcher,
    send,
    now,
    registrationId: device.registrationId,
    accept: (notification: PushNotification) =>
      store.accept('host', device.registrationId, notification),
    advance: (ms: number) => {
      time += ms
    }
  }
}

it('rechecks the device before a persisted retry and does not send after unregistration', async () => {
  const h = await fixture()
  h.send.mockResolvedValue({ status: 'error', reason: 'timeout', retryable: true })
  await h.accept(note(1))
  await h.worker.runDue()
  await h.devices.deleteOwned('host', h.registrationId)
  h.advance(3000)
  await h.worker.runDue()
  expect(h.send).toHaveBeenCalledOnce()
  expect(await h.store.pendingCount(h.registrationId)).toBe(0)
})

it('stops queued claim admissions without leasing the remaining device', async () => {
  const h = await fixture()
  const other = await h.devices.upsert({
    hostFingerprint: 'host',
    deviceId: 'phone-queued',
    platform: 'android',
    token: 'queued-token'
  })
  if (!other.ok) throw new Error('registration failed')
  await h.accept(note(1))
  h.advance(1)
  await h.store.accept('host', other.registrationId, note(2))
  const paused = pauseAfter(h.db)
  const store = new DurablePushStore(h.db, h.now, paused.wrapped)
  const worker = new DurablePushWorker(store, h.dispatcher, { now: h.now })
  const pending = worker.runDue()
  try {
    await paused.atCandidate
    const stopping = worker.stop()
    paused.release()
    await within(Promise.all([pending, stopping]), 2_000)
    expect(h.send).toHaveBeenCalledOnce()
    const [remaining] = await h.db.query(
      'SELECT attempts, lease_until FROM push_delivery_batches WHERE registration_id = ?',
      [other.registrationId]
    )
    expect(Number(remaining?.attempts)).toBe(0)
    expect(Number(remaining?.lease_until)).toBe(0)
  } finally {
    paused.release()
    await worker.stop()
    await pending
  }
})

it('claims new devices while an earlier provider response is still pending', async () => {
  const h = await fixture()
  const second = await h.devices.upsert({
    hostFingerprint: 'host',
    deviceId: 'phone-second',
    platform: 'android',
    token: 'second-token'
  })
  const third = await h.devices.upsert({
    hostFingerprint: 'host',
    deviceId: 'phone-third',
    platform: 'android',
    token: 'third-token'
  })
  if (!second.ok || !third.ok) throw new Error('registration failed')
  const held = Promise.withResolvers<PushProviderOutcome>()
  const entered = Promise.withResolvers<void>()
  const secondSent = Promise.withResolvers<void>()
  const thirdSent = Promise.withResolvers<void>()
  h.send.mockImplementation(async (delivery) => {
    if (delivery.orca.notificationSeq === 1) {
      entered.resolve()
      return await held.promise
    }
    if (delivery.orca.notificationSeq === 2) secondSent.resolve()
    if (delivery.orca.notificationSeq === 3) thirdSent.resolve()
    return { status: 'sent' }
  })
  await h.accept(note(1))
  h.worker.start()
  h.worker.wake()
  try {
    await within(entered.promise, 2_000)
    await h.store.accept('host', second.registrationId, note(2))
    h.worker.wake()
    await within(secondSent.promise, 2_000)
    await h.store.accept('host', third.registrationId, note(3))
    h.worker.wake()
    await within(thirdSent.promise, 2_000)
    expect(await h.store.pendingCount(h.registrationId)).toBe(1)
    expect(h.send).toHaveBeenCalledTimes(3)
  } finally {
    held.resolve({ status: 'sent' })
    await h.worker.stop()
  }
})

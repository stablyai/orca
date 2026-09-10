import { afterEach, expect, it, vi } from 'vitest'
import type { PushNotification } from '@orca-cloud/push-contract'
import { DurablePushStore } from './durable-push-store.js'
import { DurablePushWorker } from './durable-push-worker.js'
import { PushDispatcher } from './push-dispatcher.js'
import { PushDeviceRegistryStore } from './device-registry-store.js'
import { openInMemoryPushDatabase } from './push-database.js'
import type { PushDelivery } from './push-delivery-message.js'
import type { PushProviderOutcome } from './push-provider-outcome.js'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
  vi.useRealTimers()
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
  const onRetry = vi.fn()
  const dispatcher = new PushDispatcher({ devices, fcm: { send } as never })
  const worker = new DurablePushWorker(store, dispatcher, { now, onRetry })
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
    onRetry,
    now,
    registrationId: device.registrationId,
    accept: (notification: PushNotification) =>
      store.accept('host', device.registrationId, notification),
    advance: (ms: number) => {
      time += ms
    }
  }
}

it('sends every burst event immediately with its original content and identity', async () => {
  const h = await fixture()
  await h.accept(note(1))
  await h.accept(
    note(2, { agentState: 'needs-input', title: 'Answer needed', body: 'Please respond' })
  )
  await h.worker.runDue()
  expect(h.send).toHaveBeenCalledTimes(2)
  const first = h.send.mock.calls.find(([delivery]) => delivery.orca.notificationSeq === 1)![0]
  const second = h.send.mock.calls.find(([delivery]) => delivery.orca.notificationSeq === 2)![0]
  expect(first).toMatchObject({
    title: 'Done',
    body: 'Finished task',
    orca: {
      notificationId: 'note-1',
      notificationSeq: 1
    }
  })
  expect(second).toMatchObject({
    title: 'Answer needed',
    body: 'Please respond',
    orca: { notificationId: 'note-2', notificationSeq: 2 }
  })
  expect(first.collapseId).not.toBe(second.collapseId)
  expect(h.send.mock.calls.every(([delivery]) => !('coalescedCount' in delivery.orca))).toBe(true)
  expect(h.send.mock.calls.every(([delivery]) => !('summaryMembers' in delivery.orca))).toBe(true)
  expect(h.onRetry).not.toHaveBeenCalled()
})

it('keeps untrackable bells and per-phone deliveries individually replaceable', async () => {
  const h = await fixture()
  const other = await h.devices.upsert({
    hostFingerprint: 'host',
    deviceId: 'phone2',
    platform: 'android',
    token: 'other-token'
  })
  if (!other.ok) throw new Error('registration failed')
  await h.accept(note(1, { notificationId: undefined, source: 'terminal-bell', agentState: null }))
  await h.accept(note(2))
  await h.accept(note(3))
  await h.store.accept('host', other.registrationId, note(2))
  await h.worker.runDue()
  expect(h.send).toHaveBeenCalledTimes(4)
  const deliveries = h.send.mock.calls.map(([delivery]) => delivery)
  const primary = deliveries.filter((delivery) => delivery.registrationId === h.registrationId)
  expect(primary).toHaveLength(3)
  expect(new Set(primary.map((delivery) => delivery.collapseId)).size).toBe(3)
  expect(
    deliveries.find((delivery) => delivery.registrationId === other.registrationId)
  ).toMatchObject({ orca: { notificationId: 'note-2', notificationSeq: 2 } })
})

it('persists provider retry delay and resumes it through a new worker', async () => {
  const h = await fixture()
  h.send.mockResolvedValueOnce({
    status: 'error',
    reason: 'busy',
    retryable: true,
    retryAfterMs: 10000
  })
  await h.accept(note(1))
  await h.worker.runDue()
  expect(h.send).toHaveBeenCalledOnce()
  await h.worker.stop()
  const restarted = new DurablePushWorker(h.store, h.dispatcher, { now: h.now, onRetry: h.onRetry })
  h.advance(9999)
  await restarted.runDue()
  expect(h.send).toHaveBeenCalledOnce()
  h.advance(1)
  await restarted.runDue()
  expect(h.send).toHaveBeenCalledTimes(2)
  expect(h.send.mock.calls.map(([delivery]) => delivery.expiresAt)).toEqual([1_300_000, 1_300_000])
  expect(h.onRetry).toHaveBeenCalledOnce()
  expect(await h.store.pendingCount(h.registrationId)).toBe(0)
  await restarted.stop()
})

it('expires instead of shortening a provider delay beyond the delivery lifetime', async () => {
  const h = await fixture()
  h.send.mockResolvedValue({
    status: 'error',
    reason: 'busy',
    retryable: true,
    retryAfterMs: 600000
  })
  await h.accept(note(1))
  await h.worker.runDue()
  h.advance(600000)
  await h.worker.runDue()
  expect(h.send).toHaveBeenCalledOnce()
  expect(await h.store.pendingCount(h.registrationId)).toBe(0)
  expect(h.onRetry).not.toHaveBeenCalled()
})

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

it('joins active work on shutdown and leaves unclaimed work for the next instance', async () => {
  const h = await fixture()
  let finish!: (outcome: PushProviderOutcome) => void
  let started!: () => void
  const entered = new Promise<void>((resolve) => {
    started = resolve
  })
  h.send.mockImplementationOnce(() => {
    started()
    return new Promise((resolve) => {
      finish = resolve
    })
  })
  await h.accept(note(1))
  const pending = h.worker.runDue()
  await entered
  await h.accept(note(2))
  let stopped = false
  const stopping = h.worker.stop().then(() => {
    stopped = true
  })
  await Promise.resolve()
  expect(stopped).toBe(false)
  finish({ status: 'sent' })
  await Promise.all([pending, stopping])
  expect(stopped).toBe(true)
  expect(h.send).toHaveBeenCalledOnce()
  const resumed = new DurablePushWorker(h.store, h.dispatcher, { now: h.now })
  await resumed.runDue()
  expect(h.send).toHaveBeenCalledTimes(2)
  await resumed.stop()
})

it('runs due work on its timer and releases the timer on stop', async () => {
  const h = await fixture()
  vi.useFakeTimers()
  await h.accept(note(1))
  h.worker.start()
  h.worker.start()
  expect(vi.getTimerCount()).toBe(1)
  await vi.advanceTimersByTimeAsync(1000)
  await h.worker.runDue()
  expect(h.send).toHaveBeenCalledOnce()
  await h.worker.stop()
  expect(vi.getTimerCount()).toBe(0)
})

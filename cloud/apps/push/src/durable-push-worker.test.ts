import { setImmediate } from 'node:timers/promises'
import { afterEach, expect, it, vi } from 'vitest'
import type { PushNotification } from '@orca-cloud/push-contract'
import { DurablePushStore } from './durable-push-store.js'
import { DurablePushWorker } from './durable-push-worker.js'
import { PushDispatcher } from './push-dispatcher.js'
import { PushDeviceRegistryStore } from './device-registry-store.js'
import { openInMemoryPushDatabase } from './push-database.js'
import type { PushDelivery } from './push-delivery-message.js'
import type { PushProviderOutcome } from './push-provider-outcome.js'
import { WORKER_DRAINS } from './push-worker-concurrency.js'

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

it('preserves provider retry delay when waking a restarted worker', async () => {
  const h = await fixture()
  vi.useFakeTimers()
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
  restarted.start()
  h.advance(9999)
  restarted.wake()
  await restarted.runDue()
  expect(h.send).toHaveBeenCalledOnce()
  h.advance(1)
  restarted.wake()
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
  vi.useFakeTimers()
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
  h.worker.start()
  h.worker.wake()
  const pending = h.worker.runDue()
  await entered
  await h.accept(note(2))
  h.worker.wake()
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
  expect(vi.getTimerCount()).toBe(0)
  const resumed = new DurablePushWorker(h.store, h.dispatcher, { now: h.now })
  resumed.start()
  await vi.advanceTimersByTimeAsync(1000)
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

it('wakes only while started and keeps the durability poll', async () => {
  const h = await fixture()
  vi.useFakeTimers()
  const claim = vi.spyOn(h.store, 'claim')
  await h.accept(note(1))
  h.worker.wake()
  expect(claim).not.toHaveBeenCalled()
  h.worker.start()
  h.worker.wake()
  expect(claim).toHaveBeenCalled()
  await h.worker.runDue()
  expect(h.send).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(1)
  await h.worker.stop()
  const calls = claim.mock.calls.length
  await h.accept(note(2))
  h.worker.wake()
  await vi.advanceTimersByTimeAsync(2000)
  expect(claim).toHaveBeenCalledTimes(calls)
  expect(await h.store.pendingCount(h.registrationId)).toBe(1)
  expect(vi.getTimerCount()).toBe(0)
})

it('coalesces wakes arriving after every active drain found an empty queue', async () => {
  const h = await fixture()
  vi.useFakeTimers()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const claim = h.store.claim.bind(h.store)
  let empty = 0
  let holding = true
  vi.spyOn(h.store, 'claim').mockImplementation(async () => {
    const delivery = await claim()
    if (!delivery && holding) {
      if (++empty === WORKER_DRAINS) entered.resolve()
      await release.promise
    }
    return delivery
  })
  h.worker.start()
  const startedAt = Date.now()
  const pending = h.worker.runDue()
  try {
    await entered.promise
    await h.accept(note(1))
    for (let count = 0; count < 10; count++) h.worker.wake()
    expect(h.store.claim).toHaveBeenCalledTimes(WORKER_DRAINS)
    holding = false
    release.resolve()
    await pending
    await vi.waitFor(() => expect(h.send).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(h.store.claim).toHaveBeenCalledTimes(WORKER_DRAINS + 2))
    expect(Date.now() - startedAt).toBeLessThan(1000)
    expect(h.send.mock.calls[0]?.[0].orca.notificationSeq).toBe(1)
  } finally {
    holding = false
    release.resolve()
  }
})

it('bounds claims by sends plus drains for a burst and a trickle of wakes', async () => {
  const h = await fixture()
  const registrations: string[] = []
  for (let index = 0; index < 50; index++) {
    const device = await h.devices.upsert({
      hostFingerprint: `host-${index}`,
      deviceId: `phone-${index}`,
      platform: 'android',
      token: `token-${index}`
    })
    if (!device.ok) throw new Error('registration failed')
    registrations.push(device.registrationId)
  }
  const claim = vi.spyOn(h.store, 'claim')
  const sendOne = async (index: number) => {
    const status = await h.store.accept(
      `host-${index % 50}`,
      registrations[index % 50]!,
      note(index + 1)
    )
    expect(status).toBe('queued')
    h.worker.wake()
  }
  // Fake timers hold the poll, so only wakes claim.
  vi.useFakeTimers()
  h.worker.start()
  const settle = async () => {
    for (let ticks = 0; ticks < 1000; ticks++) await setImmediate()
  }
  await Promise.all(Array.from({ length: 1000 }, (_, index) => sendOne(index)))
  await settle()
  // Each drain stops after 25 sends, so the poll finishes a large burst.
  let polls = 0
  while (h.send.mock.calls.length < 1000 && polls < 10) {
    await vi.advanceTimersByTimeAsync(1000)
    await settle()
    polls++
  }
  expect(h.send).toHaveBeenCalledTimes(1000)
  expect(claim.mock.calls.length).toBeLessThanOrEqual(1000 + WORKER_DRAINS * (polls + 2))
  claim.mockClear()
  // Before one-drain wakes, each idle send started every drain: ~13 claims per send.
  for (let index = 1000; index < 1020; index++) {
    await sendOne(index)
    await settle()
  }
  expect(h.send).toHaveBeenCalledTimes(1020)
  expect(claim).toHaveBeenCalledTimes(40)
}, 60_000)

it('recovers from a failed automatic wake without leaving another timer', async () => {
  const h = await fixture()
  vi.useFakeTimers()
  vi.spyOn(h.store, 'claim').mockRejectedValueOnce(new Error('database unavailable'))
  h.worker.start()
  h.worker.wake()
  await vi.waitFor(() =>
    expect(console.warn).toHaveBeenCalledWith(JSON.stringify({ event: 'orca_push_worker_failed' }))
  )
  await h.accept(note(1))
  h.worker.wake()
  await vi.waitFor(() => expect(h.send).toHaveBeenCalledOnce())
  await h.worker.stop()
  expect(vi.getTimerCount()).toBe(0)
})

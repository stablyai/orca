import { afterEach, expect, it, vi } from 'vitest'
import { startPushBackground } from './push-background.js'
import { createPushHostKeypair } from './host-challenge-answering.test-fixture.js'
import { createPushServerHarness, notification } from './push-server-harness.test-fixture.js'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

async function fixture() {
  const h = await createPushServerHarness()
  const token = await h.signIn(createPushHostKeypair(31))
  const registrationId = await h.registerAndroid(token)
  let stop = async () => {}
  cleanups.push(async () => {
    await stop()
    await h.close()
  })
  vi.useFakeTimers()
  return {
    ...h,
    registrationId,
    start: () => {
      stop = startPushBackground({ mode: 'active' }, h.server)
    },
    send: (event = notification(), ids = [registrationId]) =>
      h.post('/v1/send', { v: 1, registrationIds: ids, notification: event }, token),
    invalid: () => h.post('/v1/send', { v: 1 }, token)
  }
}

it('delivers a committed send before the next poll without waiting in the HTTP handler', async () => {
  const h = await fixture()
  h.start()
  const startedAt = Date.now()
  const claim = h.server.deliveryStore.claim.bind(h.server.deliveryStore)
  const release = Promise.withResolvers<void>()
  vi.spyOn(h.server.deliveryStore, 'claim').mockImplementation(async () => {
    await release.promise
    return claim()
  })
  try {
    const response = await h.send()
    expect(await response.json()).toEqual({
      results: [{ registrationId: h.registrationId, status: 'queued' }]
    })
    expect(h.fcmRequests).toHaveLength(0)
    release.resolve()
    await vi.waitFor(() => expect(h.fcmRequests).toHaveLength(1))
    expect(Date.now() - startedAt).toBeLessThan(1000)
    expect(JSON.parse(h.fcmRequests[0]!.body).message.data.notificationSeq).toBe('1')
  } finally {
    release.resolve()
  }
})

it('keeps concurrent accepted retries idempotent while automatic delivery runs', async () => {
  const h = await fixture()
  h.start()
  await Promise.all(Array.from({ length: 10 }, () => h.send()))
  await vi.waitFor(() => expect(h.fcmRequests).toHaveLength(1))
  await h.send()
  await h.server.worker.runDue()
  expect(h.fcmRequests).toHaveLength(1)
  expect(await h.server.deliveryStore.pendingCount(h.registrationId)).toBe(0)
})

it('does not wake for invalid, unowned or dead registrations', async () => {
  const h = await fixture()
  h.start()
  const wake = vi.spyOn(h.server.worker, 'wake')
  expect((await h.invalid()).status).toBe(400)
  expect(await (await h.send(notification(), ['unknown'])).json()).toEqual({
    results: [{ registrationId: 'unknown', status: 'error' }]
  })
  const device = await h.server.devices.findById(h.registrationId)
  if (!device) throw new Error('registration missing')
  await h.server.devices.markDead(device)
  expect(await (await h.send()).json()).toEqual({
    results: [{ registrationId: h.registrationId, status: 'dead' }]
  })
  expect(wake).not.toHaveBeenCalled()
  expect(h.fcmRequests).toHaveLength(0)
})

it.each(['error', 'rate_limited'] as const)('does not wake a refused %s send', async (status) => {
  const h = await fixture()
  h.start()
  const wake = vi.spyOn(h.server.worker, 'wake')
  vi.spyOn(h.server.deliveryStore, 'accept').mockResolvedValue(status)
  expect(await (await h.send()).json()).toEqual({
    results: [{ registrationId: h.registrationId, status }]
  })
  expect(wake).not.toHaveBeenCalled()
})

it.each(['queued', 'sent'] as const)(
  'preserves dismissal of an already %s alert',
  async (phase) => {
    const h = await fixture()
    if (phase === 'sent') h.start()
    await h.send()
    if (phase === 'sent') await vi.waitFor(() => expect(h.fcmRequests).toHaveLength(1))
    await h.send(notification({ kind: 'dismiss', notificationSeq: 2, sound: false }))
    if (phase === 'queued') {
      h.start()
      await vi.advanceTimersByTimeAsync(1000)
    }
    await vi.waitFor(() => expect(h.fcmRequests).toHaveLength(phase === 'sent' ? 2 : 1))
    const last = h.fcmRequests.at(-1)
    if (!last) throw new Error('dismissal missing')
    const message = JSON.parse(last.body).message
    expect(message.data.kind).toBe('dismiss')
    expect(message.data.notificationId).toBe('note-1')
    expect(message.data.notificationSeq).toBe('2')
    expect(message.data.title).toBeUndefined()
    expect(message.data.sound).toBeUndefined()
  }
)

import { afterEach, expect, it, vi } from 'vitest'
import { startPushBackground } from '../push-background.js'
import { createPushHostKeypair } from '../host-auth/host-challenge-answering.test-fixture.js'
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

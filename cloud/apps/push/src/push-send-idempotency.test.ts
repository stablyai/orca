import { afterEach, expect, it } from 'vitest'
import { createPushServerHarness, notification } from './push-server-harness.test-fixture.js'
import { createPushHostKeypair } from './host-challenge-answering.test-fixture.js'
const harnesses: Awaited<ReturnType<typeof createPushServerHarness>>[] = []
afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((h) => h.close()))
})

it('returns queued for concurrent retries without double quota or delivery', async () => {
  const h = await createPushServerHarness()
  harnesses.push(h)
  const token = await h.signIn(createPushHostKeypair(2))
  const registrationId = await h.registerAndroid(token)
  const body = { v: 1, registrationIds: [registrationId], notification: notification() }
  const responses = await Promise.all(
    Array.from({ length: 10 }, () => h.post('/v1/send', body, token))
  )
  for (const response of responses)
    expect(await response.json()).toEqual({ results: [{ registrationId, status: 'queued' }] })
  expect(await h.server.deliveryStore.pendingCount(registrationId)).toBe(1)
  await h.flushDeliveries()
  await h.post('/v1/send', body, token)
  await h.flushDeliveries()
  expect(h.fcmRequests).toHaveLength(1)
  expect(JSON.parse(h.fcmRequests[0]!.body).message.data.coalescedCount).toBeUndefined()
  expect(
    Number((await h.database.query('SELECT COUNT(*) AS count FROM push_events'))[0]?.count)
  ).toBe(1)
  await h.post(
    '/v1/send',
    { ...body, notification: notification({ notificationEpoch: 'new-epoch' }) },
    token
  )
  await h.flushDeliveries()
  expect(h.fcmRequests).toHaveLength(2)
})

it.each([false, true])(
  'accepts default alert kind equivalently through the API (explicit first: %s)',
  async (explicitFirst) => {
    const h = await createPushServerHarness()
    harnesses.push(h)
    const token = await h.signIn(createPushHostKeypair(3))
    const registrationId = await h.registerAndroid(token)
    const implicit = notification()
    const explicit = { kind: 'alert', ...implicit }
    for (const event of explicitFirst ? [explicit, implicit] : [implicit, explicit]) {
      const response = await h.post(
        '/v1/send',
        { v: 1, registrationIds: [registrationId], notification: event },
        token
      )
      expect(await response.json()).toEqual({ results: [{ registrationId, status: 'queued' }] })
    }
    await h.flushDeliveries()
    expect(h.fcmRequests).toHaveLength(1)
    const changed = await h.post(
      '/v1/send',
      { v: 1, registrationIds: [registrationId], notification: { ...explicit, body: 'changed' } },
      token
    )
    expect(await changed.json()).toEqual({ results: [{ registrationId, status: 'error' }] })
  }
)

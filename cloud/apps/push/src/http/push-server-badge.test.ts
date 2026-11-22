import { afterEach, beforeEach, expect, it } from 'vitest'
import { createPushHostKeypair } from '../host-auth/host-challenge-answering.test-fixture.js'
import {
  APNS_TOKEN,
  createPushServerHarness,
  notification
} from './push-server-harness.test-fixture.js'

let harness: Awaited<ReturnType<typeof createPushServerHarness>>

beforeEach(async () => {
  harness = await createPushServerHarness()
})

afterEach(async () => {
  await harness.close()
})

async function pairedHost(seed: number): Promise<{ session: string; registrationId: string }> {
  const session = await harness.signIn(createPushHostKeypair(seed))
  const response = await harness.post(
    '/v1/devices',
    { v: 1, deviceId: 'phone', platform: 'ios', token: APNS_TOKEN, apnsEnvironment: 'production' },
    session
  )
  const { registrationId } = (await response.json()) as { registrationId: string }
  return { session, registrationId }
}

async function sendBadge(
  host: { session: string; registrationId: string },
  badge: number,
  seq: number
) {
  const response = await harness.post(
    '/v1/send',
    {
      v: 1,
      registrationIds: [host.registrationId],
      notification: notification({
        kind: 'badge',
        badge,
        notificationId: undefined,
        notificationSeq: seq,
        agentState: null,
        title: 'Orca',
        body: ''
      })
    },
    host.session
  )
  expect(await response.json()).toEqual({
    results: [{ registrationId: host.registrationId, status: 'queued' }]
  })
  await harness.flushDeliveries()
}

const lastApns = () => {
  const request = harness.apnsRequests.at(-1)!
  return { headers: request.headers, body: JSON.parse(request.body) }
}

it("shows the sum of every paired host's unread count on the phone's icon", async () => {
  const first = await pairedHost(31)
  const second = await pairedHost(32)

  await sendBadge(first, 2, 1)
  expect(lastApns().body).toEqual({ aps: { badge: 2 } })
  expect(lastApns().headers['apns-expiration']).toBe('0')

  await sendBadge(second, 3, 1)
  expect(lastApns().body).toEqual({ aps: { badge: 5 } })

  await harness.post(
    '/v1/send',
    { v: 1, registrationIds: [second.registrationId], notification: notification() },
    second.session
  )
  await harness.flushDeliveries()
  expect(lastApns().body.aps).toMatchObject({ alert: { title: 'Agent needs input' }, badge: 5 })

  const removed = await harness.authorized(
    `/v1/devices/${first.registrationId}`,
    { method: 'DELETE' },
    first.session
  )
  expect(removed.status).toBe(204)
  await harness.flushDeliveries()
  expect(lastApns().body).toEqual({ aps: { badge: 3 } })
})

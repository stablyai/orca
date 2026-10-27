import { expect, it } from 'vitest'
import { createPushHostKeypair } from './host-challenge-answering.test-fixture.js'
import {
  APNS_TOKEN,
  createPushServerHarness,
  notification
} from './push-server-harness.test-fixture.js'

it('delivers again after a topic error without re-registering the phone', async () => {
  const h = await createPushServerHarness()
  try {
    const token = await h.signIn(createPushHostKeypair(71))
    const registered = await h.post(
      '/v1/devices',
      {
        v: 1,
        deviceId: 'phone',
        platform: 'ios',
        token: APNS_TOKEN,
        apnsEnvironment: 'sandbox'
      },
      token
    )
    const { registrationId } = (await registered.json()) as { registrationId: string }
    h.setApnsResponse({ status: 400, body: JSON.stringify({ reason: 'DeviceTokenNotForTopic' }) })
    for (const seq of [1, 2]) {
      const sent = await h.post(
        '/v1/send',
        {
          v: 1,
          registrationIds: [registrationId],
          notification: notification({ notificationId: `topic-${seq}`, notificationSeq: seq })
        },
        token
      )
      expect(await sent.json()).toEqual({ results: [{ registrationId, status: 'queued' }] })
      await h.flushDeliveries()
      if (seq === 1) {
        expect(h.server.observability.consume().delivery_error).toBe(1)
        h.setApnsResponse({ status: 200, body: '' })
      }
    }
    expect(h.apnsRequests).toHaveLength(2)
    expect(h.server.observability.consume().delivery_sent).toBe(1)
  } finally {
    await h.close()
  }
})

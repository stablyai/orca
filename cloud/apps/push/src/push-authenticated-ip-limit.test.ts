import { PUSH_LIMITS } from '@orca-cloud/push-contract'
import { expect, it } from 'vitest'
import { createPushHostKeypair } from './host-challenge-answering.test-fixture.js'
import { createPushServerHarness, FCM_TOKEN } from './push-server-harness.test-fixture.js'

it('bounds valid hosts together across routes without letting key rotation reset the IP budget', async () => {
  const harness = await createPushServerHarness()
  const headers = { 'x-forwarded-for': '203.0.113.7' }
  try {
    const hostCount =
      PUSH_LIMITS.authenticatedRequestsPerMinutePerIp /
      PUSH_LIMITS.authenticatedRequestsPerMinutePerHost
    for (let host = 0; host < hostCount; host++) {
      const token = await harness.signIn(createPushHostKeypair(host + 1))
      for (
        let request = 0;
        request < PUSH_LIMITS.authenticatedRequestsPerMinutePerHost;
        request++
      ) {
        expect((await harness.authorized('/v1/devices', { headers }, token)).status).toBe(200)
      }
    }
    const token = await harness.signIn(createPushHostKeypair(99))
    const registration = {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ v: 1, deviceId: 'phone', platform: 'android', token: FCM_TOKEN })
    }
    expect((await harness.authorized('/v1/devices', registration, token)).status).toBe(429)
    expect((await harness.authorized('/v1/send', { method: 'POST', headers }, token)).status).toBe(
      429
    )
    expect(
      (
        await harness.authorized(
          '/v1/devices',
          {
            ...registration,
            headers: { ...registration.headers, 'x-forwarded-for': '198.51.100.9' }
          },
          token
        )
      ).status
    ).toBe(200)
    harness.advanceClock(60_000)
    expect((await harness.authorized('/v1/devices', registration, token)).status).toBe(200)
  } finally {
    await harness.close()
  }
}, 30_000)

import { expect, it } from 'vitest'
import { createPushServerHarness } from './push-server-harness.test-fixture.js'
import { createPushHostKeypair } from '../host-auth/host-challenge-answering.test-fixture.js'

it('requires host proof and encodes ActivityKit state without alert or route data', async () => {
  const harness = await createPushServerHarness()
  try {
    const push = {
      token: 'aabb', apnsEnvironment: 'sandbox', timestamp: 1_700_000_000,
      event: 'end', content: { state: 'done', title: 'Orca', stateStartedAt: 1_699_999_990, updatedAt: 1_700_000_000 }
    }
    expect((await harness.post('/v1/live-activities/send', push)).status).toBe(401)
    const session = await harness.signIn(createPushHostKeypair(51))
    expect(await (await harness.post('/v1/live-activities/send', push, session)).json()).toEqual({ status: 'sent' })
    const wire = harness.apnsRequests[0]
    expect({ host: wire.host, path: wire.path, topic: wire.headers['apns-topic'], pushType: wire.headers['apns-push-type'], body: JSON.parse(wire.body) }).toEqual({
      host: 'api.sandbox.push.apple.com', path: '/3/device/aabb',
      topic: 'com.stably.orca.mobile.push-type.liveactivity', pushType: 'liveactivity',
      body: { aps: { timestamp: 1_700_000_000, event: 'end',
        'content-state': { state: 'done', title: 'Orca', stateStartedAt: 1_699_999_990, updatedAt: 1_700_000_000 },
        'stale-date': 1_700_000_900, 'dismissal-date': 1_700_000_300 } }
    })
  } finally { await harness.close() }
})

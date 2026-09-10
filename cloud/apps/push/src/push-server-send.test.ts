import { PushNotificationSchema } from '@orca-cloud/push-contract'
import { PUSH_LIMITS } from '@orca-cloud/push-contract'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPushHostKeypair } from './host-challenge-answering.test-fixture.js'
import {
  APNS_TOKEN,
  createPushServerHarness,
  FCM_TOKEN,
  notification
} from './push-server-harness.test-fixture.js'

describe('push gateway send route', () => {
  let harness: Awaited<ReturnType<typeof createPushServerHarness>>

  beforeEach(async () => {
    harness = await createPushServerHarness()
  })

  afterEach(async () => {
    await harness.close()
  })

  it('rejects a batch over the registration cap', async () => {
    const sessionToken = await harness.signIn(createPushHostKeypair(16))
    const oversized = await harness.post(
      '/v1/send',
      {
        v: 1,
        registrationIds: Array.from(
          { length: PUSH_LIMITS.maxRegistrationIdsPerSend + 1 },
          (_, index) => `reg-${index}`
        ),
        notification: notification()
      },
      sessionToken
    )
    expect(oversized.status).toBe(400)
    expect(await oversized.json()).toEqual({ error: 'invalid_request' })
  })

  it('queues a send, delivers it to fcm, and reports a dead token on the next send', async () => {
    const sessionToken = await harness.signIn(createPushHostKeypair(17))
    const registrationId = await harness.registerAndroid(sessionToken)

    const queued = await harness.post(
      '/v1/send',
      { v: 1, registrationIds: [registrationId], notification: notification() },
      sessionToken
    )
    expect(await queued.json()).toEqual({ results: [{ registrationId, status: 'queued' }] })

    harness.setFcmResponse({
      status: 404,
      body: JSON.stringify({ error: { status: 'UNREGISTERED', message: 'gone' } })
    })
    await harness.flushDeliveries()
    expect(harness.fcmRequests).toHaveLength(1)
    expect(JSON.parse(harness.fcmRequests[0]!.body)).toMatchObject({
      message: { token: FCM_TOKEN, notification: { title: 'Agent needs input' } }
    })

    const afterDeath = await harness.post(
      '/v1/send',
      { v: 1, registrationIds: [registrationId], notification: notification() },
      sessionToken
    )
    expect(await afterDeath.json()).toEqual({ results: [{ registrationId, status: 'dead' }] })

    const listed = await harness.authorized('/v1/devices', {}, sessionToken)
    expect(await listed.json()).toEqual({
      devices: [{ registrationId, deviceId: 'device-1', platform: 'android', dead: true }]
    })
  })

  it('leaves a live registration alone when the provider reports a transient failure', async () => {
    const sessionToken = await harness.signIn(createPushHostKeypair(24))
    const registrationId = await harness.registerAndroid(sessionToken)
    await harness.post(
      '/v1/send',
      { v: 1, registrationIds: [registrationId], notification: notification() },
      sessionToken
    )
    harness.setFcmResponse({
      status: 503,
      body: JSON.stringify({ error: { status: 'UNAVAILABLE', message: 'backend busy' } })
    })
    await harness.flushDeliveries()
    expect(await harness.server.devices.findById(registrationId)).toMatchObject({ dead: false })
  })

  it('reports retries from the durable worker after the provider delay', async () => {
    const token = await harness.signIn(createPushHostKeypair(26))
    const registrationId = await harness.registerAndroid(token)
    await harness.post(
      '/v1/send',
      {
        v: 1,
        registrationIds: [registrationId],
        notification: notification()
      },
      token
    )
    harness.setFcmResponse({ status: 503, body: '{}' })
    await harness.flushDeliveries()
    expect(harness.server.observability.consume()).toMatchObject({
      delivery_error: 1,
      delivery_retry: 0
    })
    harness.advanceClock(10_000)
    harness.setFcmResponse({ status: 200, body: '{}' })
    await harness.server.worker.runDue()
    expect(harness.server.observability.consume()).toMatchObject({
      delivery_sent: 1,
      delivery_retry: 1
    })
  })

  it('sends a burst as individual APNs alerts grouped by the host thread', async () => {
    const sessionToken = await harness.signIn(createPushHostKeypair(18))
    const registration = await harness.post(
      '/v1/devices',
      {
        v: 1,
        deviceId: 'iphone-1',
        platform: 'ios',
        token: APNS_TOKEN,
        apnsEnvironment: 'sandbox'
      },
      sessionToken
    )
    const { registrationId } = (await registration.json()) as { registrationId: string }
    for (const seq of [1, 2, 3]) {
      await harness.post(
        '/v1/send',
        {
          v: 1,
          registrationIds: [registrationId],
          notification: notification({ notificationId: `note-${seq}`, notificationSeq: seq })
        },
        sessionToken
      )
    }
    await harness.flushDeliveries()
    expect(harness.apnsRequests).toHaveLength(3)
    const bodies = harness.apnsRequests.map(
      (request) =>
        JSON.parse(request.body) as {
          aps: { alert: { title: string; body: string }; 'thread-id': string }
          orca: Record<string, unknown> & { notificationSeq: number }
        }
    )
    expect(
      harness.apnsRequests.every((request) => request.host === 'api.sandbox.push.apple.com')
    ).toBe(true)
    expect(bodies.map((body) => body.aps.alert)).toEqual(
      Array.from({ length: 3 }, () => ({
        title: 'Agent needs input',
        body: 'Waiting on your answer'
      }))
    )
    expect(new Set(bodies.map((body) => body.aps['thread-id'])).size).toBe(1)
    expect(bodies.map((body) => body.orca.notificationSeq).sort((a, b) => a - b)).toEqual([1, 2, 3])
    expect(bodies.every((body) => !('coalescedCount' in body.orca))).toBe(true)
    expect(bodies.every((body) => !('summaryMembers' in body.orca))).toBe(true)
    expect(
      new Set(harness.apnsRequests.map((request) => request.headers['apns-collapse-id'])).size
    ).toBe(3)
  })

  it('sends a lone event through unchanged with its own collapse id', async () => {
    const sessionToken = await harness.signIn(createPushHostKeypair(25))
    const registrationId = await harness.registerAndroid(sessionToken)
    await harness.post(
      '/v1/send',
      { v: 1, registrationIds: [registrationId], notification: notification() },
      sessionToken
    )
    await harness.flushDeliveries()
    const message = JSON.parse(harness.fcmRequests[0]!.body) as {
      message: { android: { notification: { tag: string } }; data: Record<string, string> }
    }
    expect(message.message.android.notification.tag).toMatch(/^[a-f0-9]{64}$/)
    expect(message.message.data.coalescedCount).toBeUndefined()
  })

  it('reports an error for a registration the host does not own', async () => {
    const ownerToken = await harness.signIn(createPushHostKeypair(19))
    const intruderToken = await harness.signIn(createPushHostKeypair(20))
    const registrationId = await harness.registerAndroid(ownerToken)

    const foreign = await harness.post(
      '/v1/send',
      { v: 1, registrationIds: [registrationId, 'made-up'], notification: notification() },
      intruderToken
    )
    expect(await foreign.json()).toEqual({
      results: [
        { registrationId, status: 'error' },
        { registrationId: 'made-up', status: 'error' }
      ]
    })
    expect(await harness.server.deliveryStore.pendingCount(registrationId)).toBe(0)
  })

  it('rate limits a host that exhausted its 15-minute allowance', async () => {
    const sessionToken = await harness.signIn(createPushHostKeypair(21))
    const registrationId = await harness.registerAndroid(sessionToken)
    const hostFingerprint = (await harness.server.devices.findById(registrationId))!.hostFingerprint
    for (let index = 0; index < PUSH_LIMITS.hostEventsPerWindow; index++) {
      expect(
        await harness.server.deliveryStore.accept(
          hostFingerprint,
          registrationId,
          PushNotificationSchema.parse(
            notification({ notificationId: `note-${index + 1000}`, notificationSeq: index + 1000 })
          )
        )
      ).toBe('queued')
    }
    const limited = await harness.post(
      '/v1/send',
      { v: 1, registrationIds: [registrationId], notification: notification() },
      sessionToken
    )
    expect(limited.status).toBe(200)
    expect(await limited.json()).toEqual({ results: [{ registrationId, status: 'rate_limited' }] })
    expect(await harness.server.deliveryStore.pendingCount(registrationId)).toBe(300)
  })
})

import { PUSH_LIMITS } from '@orca-cloud/push-contract'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPushHostKeypair } from './host-challenge-answering.test-fixture.js'
import {
  APNS_TOKEN,
  createPushServerHarness,
  FCM_TOKEN,
  FILTER,
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
    await harness.server.coalescer.flushAll()
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
    await harness.server.coalescer.flushAll()
    expect(await harness.server.devices.findById(registrationId)).toMatchObject({ dead: false })
  })

  it('coalesces a burst into one apns summary under the host collapse id', async () => {
    const sessionToken = await harness.signIn(createPushHostKeypair(18))
    const registration = await harness.post(
      '/v1/devices',
      {
        v: 1,
        deviceId: 'iphone-1',
        platform: 'ios',
        token: APNS_TOKEN,
        apnsEnvironment: 'sandbox',
        filter: FILTER
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
    await harness.server.coalescer.flushAll()
    expect(harness.apnsRequests).toHaveLength(1)
    const request = harness.apnsRequests[0]!
    expect(request.host).toBe('api.sandbox.push.apple.com')
    const body = JSON.parse(request.body) as {
      aps: { alert: { title: string; body: string } }
      orca: { coalescedCount: number; notificationSeq: number }
    }
    expect(body.aps.alert).toEqual({ title: 'Orca', body: '3 agents need attention' })
    expect(body.orca.coalescedCount).toBe(3)
    expect(body.orca.notificationSeq).toBe(3)
    expect(request.headers['apns-collapse-id']).toMatch(/^host:/)
  })

  it('sends a lone event through unchanged with its own collapse id', async () => {
    const sessionToken = await harness.signIn(createPushHostKeypair(25))
    const registrationId = await harness.registerAndroid(sessionToken)
    await harness.post(
      '/v1/send',
      { v: 1, registrationIds: [registrationId], notification: notification() },
      sessionToken
    )
    await harness.server.coalescer.flushAll()
    const message = JSON.parse(harness.fcmRequests[0]!.body) as {
      message: { android: { notification: { tag: string } }; data: Record<string, string> }
    }
    expect(message.message.android.notification.tag).toBe('note-1')
    expect(message.message.data.coalescedCount).toBe('1')
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
    expect(harness.server.coalescer.pendingCount(registrationId)).toBe(0)
  })

  it('rate limits a host that exhausted its hourly allowance', async () => {
    const sessionToken = await harness.signIn(createPushHostKeypair(21))
    const registrationId = await harness.registerAndroid(sessionToken)
    const hostFingerprint = (await harness.server.devices.findById(registrationId))!.hostFingerprint
    for (let index = 0; index < PUSH_LIMITS.hostSendsPerRollingHour; index++) {
      expect(await harness.server.quota.reserve(hostFingerprint, registrationId)).toBe('allowed')
    }
    const limited = await harness.post(
      '/v1/send',
      { v: 1, registrationIds: [registrationId], notification: notification() },
      sessionToken
    )
    expect(limited.status).toBe(200)
    expect(await limited.json()).toEqual({ results: [{ registrationId, status: 'rate_limited' }] })
    expect(harness.server.coalescer.pendingCount(registrationId)).toBe(0)
  })
})

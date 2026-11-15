import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPushHostKeypair } from '../host-auth/host-challenge-answering.test-fixture.js'
import {
  createPushServerHarness,
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

    const afterDeath = await harness.post(
      '/v1/send',
      { v: 1, registrationIds: [registrationId], notification: notification() },
      sessionToken
    )
    expect(await afterDeath.json()).toEqual({ results: [{ registrationId, status: 'dead' }] })
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
})

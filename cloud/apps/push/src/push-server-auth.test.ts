import { PUSH_LIMITS } from '@orca-cloud/push-contract'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPushHostKeypair } from './host-challenge-answering.test-fixture.js'
import type { PushDatabase } from './push-database.js'
import { createPushServer } from './push-server.js'
import {
  createPushServerHarness,
  FILTER,
  testPushConfig
} from './push-server-harness.test-fixture.js'

describe('push gateway authentication and device routes', () => {
  let harness: Awaited<ReturnType<typeof createPushServerHarness>>

  beforeEach(async () => {
    harness = await createPushServerHarness()
  })

  afterEach(async () => {
    await harness.close()
  })

  it('answers health unconditionally and ready from the database', async () => {
    expect((await harness.server.app.request('/health')).status).toBe(200)
    expect((await harness.server.app.request('/ready')).status).toBe(200)
  })

  it('reports not ready when the database is unreachable', async () => {
    const unreachable: PushDatabase = {
      dialect: 'sqlite',
      query: async () => {
        throw new Error('no connection')
      },
      transaction: async (operation) => await operation(unreachable),
      lockQuotaScope: async () => undefined,
      close: async () => undefined
    }
    const broken = createPushServer(testPushConfig(), unreachable, {
      fcmAccessToken: async () => 'token',
      fcmTransport: async () => ({ status: 200, body: '{}' })
    })
    expect((await broken.app.request('/health')).status).toBe(200)
    expect((await broken.app.request('/ready')).status).toBe(503)
    broken.coalescer.stop()
  })

  it('completes challenge, session, register, list, delete', async () => {
    const sessionToken = await harness.signIn(createPushHostKeypair(11))
    const registrationId = await harness.registerAndroid(sessionToken)

    const list = await harness.authorized('/v1/devices', {}, sessionToken)
    expect(await list.json()).toEqual({
      devices: [{ registrationId, deviceId: 'device-1', platform: 'android', dead: false }]
    })

    const deleted = await harness.authorized(
      `/v1/devices/${registrationId}`,
      { method: 'DELETE' },
      sessionToken
    )
    expect(deleted.status).toBe(204)
    expect(await harness.server.devices.findById(registrationId)).toBeNull()
  })

  it('refuses a request with no bearer, a bogus bearer, and an expired session', async () => {
    const sessionToken = await harness.signIn(createPushHostKeypair(12))
    expect((await harness.server.app.request('/v1/devices')).status).toBe(401)
    const bogus = await harness.authorized('/v1/devices', {}, 'nonsense')
    expect(bogus.status).toBe(401)
    expect(await bogus.json()).toEqual({ error: 'invalid_token' })

    harness.advanceClock(PUSH_LIMITS.sessionTtlMs + 1)
    const expired = await harness.authorized('/v1/devices', {}, sessionToken)
    expect(expired.status).toBe(401)
    expect(await expired.json()).toEqual({ error: 'session_expired' })
  })

  it('refuses a replayed proof and an unknown challenge', async () => {
    const host = createPushHostKeypair(13)
    const challenge = await harness.issueChallenge(host)
    const proof = harness.answer(challenge, host)
    expect(
      (await harness.post('/v1/host/session', {
        v: 1,
        challengeId: challenge.challengeId,
        proofB64: proof
      })).status
    ).toBe(200)

    const replay = await harness.post('/v1/host/session', {
      v: 1,
      challengeId: challenge.challengeId,
      proofB64: proof
    })
    expect(replay.status).toBe(401)
    expect(await replay.json()).toEqual({ error: 'invalid_proof' })

    const unknown = await harness.post('/v1/host/session', {
      v: 1,
      challengeId: 'no-such-challenge',
      proofB64: proof
    })
    expect(await unknown.json()).toEqual({ error: 'invalid_challenge' })
  })

  it('never returns the host fingerprint on the challenge itself', async () => {
    const challenge = await harness.issueChallenge(createPushHostKeypair(22))
    expect(Object.keys(challenge).sort()).toEqual([
      'challengeId',
      'ciphertextB64',
      'expiresAt',
      'gatewayEphemeralPublicKeyB64',
      'nonceB64'
    ])
  })

  it('lets only the owning host delete a registration', async () => {
    const ownerToken = await harness.signIn(createPushHostKeypair(14))
    const intruderToken = await harness.signIn(createPushHostKeypair(15))
    const registrationId = await harness.registerAndroid(ownerToken)

    const forbidden = await harness.authorized(
      `/v1/devices/${registrationId}`,
      { method: 'DELETE' },
      intruderToken
    )
    expect(forbidden.status).toBe(404)
    expect(await forbidden.json()).toEqual({ error: 'not_found' })
    expect(await harness.server.devices.findById(registrationId)).not.toBeNull()
  })

  it('replaces the token on a re-registration and keeps one registration id', async () => {
    const sessionToken = await harness.signIn(createPushHostKeypair(23))
    const first = await harness.registerAndroid(sessionToken)
    const again = await harness.post(
      '/v1/devices',
      {
        v: 1,
        deviceId: 'device-1',
        platform: 'android',
        token: 'rotated_token:APA91b-newnewnewnewnewnewnewnewnewnew',
        filter: FILTER
      },
      sessionToken
    )
    expect(await again.json()).toEqual({ registrationId: first })
    expect(await harness.server.devices.findById(first)).toMatchObject({
      token: 'rotated_token:APA91b-newnewnewnewnewnewnewnewnewnew'
    })
  })

  it('rejects a malformed registration body', async () => {
    const sessionToken = await harness.signIn(createPushHostKeypair(16))
    const bad = await harness.post(
      '/v1/devices',
      { v: 1, deviceId: 'device-1', platform: 'ios', token: 'not-hex', filter: FILTER },
      sessionToken
    )
    expect(bad.status).toBe(400)
    expect(await bad.json()).toEqual({ error: 'invalid_request' })
  })
})

import { PUSH_LIMITS } from '@orca-cloud/push-contract'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createPushHostKeypair,
  hostPublicKeyB64
} from './host-challenge-answering.test-fixture.js'
import {
  createPushServerHarness,
  FCM_TOKEN,
  FILTER,
  notification
} from './push-server-harness.test-fixture.js'

const CLIENT_IP = '203.0.113.7'
const OTHER_CLIENT_IP = '198.51.100.9'

function oversizedChallengeBody(): string {
  return JSON.stringify({ v: 1, filler: 'x'.repeat(PUSH_LIMITS.maxHttpBodyBytes) })
}

function chunkedRequest(path: string, body: string): Request {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body))
      controller.close()
    }
  })
  return new Request(`http://push.test${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: stream,
    duplex: 'half'
  } as RequestInit)
}

describe('push gateway request limits', () => {
  let harness: Awaited<ReturnType<typeof createPushServerHarness>>

  beforeEach(async () => {
    harness = await createPushServerHarness()
  })

  afterEach(async () => {
    await harness.close()
  })

  it('refuses an oversized chunked body that declares no content length', async () => {
    const request = chunkedRequest('/v1/host/challenge', oversizedChallengeBody())
    expect(request.headers.get('content-length')).toBeNull()

    const response = await harness.server.app.request(request)
    expect(response.status).toBe(413)
    expect(await response.json()).toEqual({ error: 'request_too_large' })
  })

  it('still refuses an oversized body that declares a content length', async () => {
    const body = oversizedChallengeBody()
    const response = await harness.server.app.request('/v1/host/challenge', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(body))
      },
      body
    })
    expect(response.status).toBe(413)
    expect(await response.json()).toEqual({ error: 'request_too_large' })
  })

  it('lets a chunked body under the cap through to schema validation', async () => {
    const response = await harness.server.app.request(
      chunkedRequest(
        '/v1/host/challenge',
        JSON.stringify({ v: 1, hostPublicKeyB64: hostPublicKeyB64(createPushHostKeypair(60)) })
      )
    )
    expect(response.status).toBe(200)
  })

  it('caps an authenticated oversized send as well', async () => {
    const sessionToken = await harness.signIn(createPushHostKeypair(61))
    const response = await harness.server.app.request(
      new Request('http://push.test/v1/send', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${sessionToken}`
        },
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(oversizedChallengeBody()))
            controller.close()
          }
        }),
        duplex: 'half'
      } as RequestInit)
    )
    expect(response.status).toBe(413)
    expect(await response.json()).toEqual({ error: 'request_too_large' })
  })

  it('rate limits one client ip across both unauthenticated routes', async () => {
    const body = JSON.stringify({
      v: 1,
      hostPublicKeyB64: hostPublicKeyB64(createPushHostKeypair(62))
    })
    // Cloud Run appends the peer, so the caller's own IP is the last value.
    const headers = {
      'content-type': 'application/json',
      'x-forwarded-for': `10.0.0.1, ${CLIENT_IP}`
    }
    for (let index = 0; index < PUSH_LIMITS.unauthenticatedRequestsPerMinutePerIp; index++) {
      const allowed = await harness.server.app.request('/v1/host/challenge', {
        method: 'POST',
        headers,
        body
      })
      expect(allowed.status).toBe(200)
    }

    const limited = await harness.server.app.request('/v1/host/challenge', {
      method: 'POST',
      headers,
      body
    })
    expect(limited.status).toBe(429)
    expect(await limited.json()).toEqual({ error: 'rate_limited' })

    // The session route draws on the same bucket, so a flood cannot simply move.
    const session = await harness.server.app.request('/v1/host/session', {
      method: 'POST',
      headers,
      body: JSON.stringify({ v: 1, challengeId: 'anything', proofB64: 'x'.repeat(44) })
    })
    expect(session.status).toBe(429)

    const other = await harness.server.app.request('/v1/host/challenge', {
      method: 'POST',
      headers: { ...headers, 'x-forwarded-for': `10.0.0.1, ${OTHER_CLIENT_IP}` },
      body
    })
    expect(other.status).toBe(200)

    // A caller rewriting the left of the chain lands in its own bucket anyway.
    const spoofed = await harness.server.app.request('/v1/host/challenge', {
      method: 'POST',
      headers: { ...headers, 'x-forwarded-for': `198.51.100.250, ${CLIENT_IP}` },
      body
    })
    expect(spoofed.status).toBe(429)
  })

  it('lets a throttled client back in once the window refills', async () => {
    const body = JSON.stringify({
      v: 1,
      hostPublicKeyB64: hostPublicKeyB64(createPushHostKeypair(63))
    })
    const headers = { 'content-type': 'application/json', 'x-forwarded-for': CLIENT_IP }
    for (let index = 0; index < PUSH_LIMITS.unauthenticatedRequestsPerMinutePerIp; index++) {
      await harness.server.app.request('/v1/host/challenge', { method: 'POST', headers, body })
    }
    expect(
      (await harness.server.app.request('/v1/host/challenge', { method: 'POST', headers, body }))
        .status
    ).toBe(429)

    harness.advanceClock(60_000)
    expect(
      (await harness.server.app.request('/v1/host/challenge', { method: 'POST', headers, body }))
        .status
    ).toBe(200)
  })

  it('never throttles an authenticated device or send route', async () => {
    const sessionToken = await harness.signIn(createPushHostKeypair(64))
    for (let index = 0; index < PUSH_LIMITS.unauthenticatedRequestsPerMinutePerIp + 5; index++) {
      const listed = await harness.authorized(
        '/v1/devices',
        { headers: { 'x-forwarded-for': CLIENT_IP } },
        sessionToken
      )
      expect(listed.status).toBe(200)
    }
  })

  it('answers 409 once a host has registered its device allowance', async () => {
    const sessionToken = await harness.signIn(createPushHostKeypair(66))
    for (let index = 0; index < PUSH_LIMITS.maxDevicesPerHost; index++) {
      const accepted = await harness.post(
        '/v1/devices',
        { v: 1, deviceId: `device-${index}`, platform: 'android', token: FCM_TOKEN, filter: FILTER },
        sessionToken
      )
      expect(accepted.status).toBe(200)
    }

    const refused = await harness.post(
      '/v1/devices',
      { v: 1, deviceId: 'one-too-many', platform: 'android', token: FCM_TOKEN, filter: FILTER },
      sessionToken
    )
    expect(refused.status).toBe(409)
    expect(await refused.json()).toEqual({ error: 'too_many_devices' })

    const listed = await harness.authorized('/v1/devices', {}, sessionToken)
    expect(((await listed.json()) as { devices: unknown[] }).devices).toHaveLength(
      PUSH_LIMITS.maxDevicesPerHost
    )
  })

  it('charges a repeated registration id once and returns one result', async () => {
    const sessionToken = await harness.signIn(createPushHostKeypair(65))
    const registrationId = await harness.registerAndroid(sessionToken)

    const response = await harness.post(
      '/v1/send',
      {
        v: 1,
        registrationIds: [registrationId, registrationId, registrationId],
        notification: notification()
      },
      sessionToken
    )
    expect(await response.json()).toEqual({ results: [{ registrationId, status: 'queued' }] })
    expect(harness.server.coalescer.pendingCount(registrationId)).toBe(1)
    const [row] = await harness.database.query('SELECT COUNT(*) AS sends FROM push_send_log')
    expect(Number(row?.sends)).toBe(1)
  })
})

import { PUSH_LIMITS } from '@orca-cloud/push-contract'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

  it('gives the authenticated routes their own, wider bucket per client ip', async () => {
    const sessionToken = await harness.signIn(createPushHostKeypair(64))
    const headers = { 'x-forwarded-for': CLIENT_IP }
    for (let index = 0; index < PUSH_LIMITS.authenticatedRequestsPerMinutePerIp; index++) {
      const listed = await harness.authorized('/v1/devices', { headers }, sessionToken)
      expect(listed.status).toBe(200)
    }
    const limited = await harness.authorized('/v1/devices', { headers }, sessionToken)
    expect(limited.status).toBe(429)
    // The handshake bucket is untouched by any of that.
    const challenge = await harness.server.app.request('/v1/host/challenge', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ v: 1, hostPublicKeyB64: hostPublicKeyB64(createPushHostKeypair(67)) })
    })
    expect(challenge.status).toBe(200)
  })

  it('caps a flood of forged bearers before any of them reaches the session lookup', async () => {
    const headers = { 'x-forwarded-for': CLIENT_IP }
    const [before] = await harness.database.query('SELECT COUNT(*) AS sessions FROM push_sessions')
    for (let index = 0; index < PUSH_LIMITS.authenticatedRequestsPerMinutePerIp; index++) {
      const refused = await harness.authorized('/v1/send', { method: 'POST', headers }, 'forged')
      expect(refused.status).toBe(401)
    }
    const limited = await harness.authorized('/v1/send', { method: 'POST', headers }, 'forged')
    expect(limited.status).toBe(429)
    expect(await limited.json()).toEqual({ error: 'rate_limited' })
    expect(harness.server.unauthenticatedIps.trackedIpCount()).toBe(0)
    const [after] = await harness.database.query('SELECT COUNT(*) AS sessions FROM push_sessions')
    expect(Number(after?.sessions)).toBe(Number(before?.sessions))
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

  // Why: a database error carries the failing row in its message. The response
  // and the log must both stop at the error's name.
  it('answers an unexpected route failure with a bare 500 and logs only the name', async () => {
    const sessionToken = await harness.signIn(createPushHostKeypair(66))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      await harness.database.close()
      const response = await harness.authorized('/v1/devices', {}, sessionToken)
      expect(response.status).toBe(500)
      expect(await response.json()).toEqual({ error: 'internal' })
      const logged = warn.mock.calls.map((call) => String(call[0])).join('\n')
      expect(logged).toContain('"event":"orca_push_request_failed"')
      expect(logged).not.toContain('SELECT')
      expect(logged).not.toContain('push_devices')
      expect(harness.server.observability.consume().request_error).toBe(1)
    } finally {
      warn.mockRestore()
    }
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

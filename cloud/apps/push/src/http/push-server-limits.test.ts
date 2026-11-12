import { PUSH_LIMITS } from '@orca-cloud/push-contract/push-limits'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createPushHostKeypair,
  hostPublicKeyB64
} from '../host-auth/host-challenge-answering.test-fixture.js'
import { createPushServerHarness } from './push-server-harness.test-fixture.js'

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

  it('limits authenticated hosts independently behind the same IP', async () => {
    const sessionToken = await harness.signIn(createPushHostKeypair(64))
    const headers = { 'x-forwarded-for': CLIENT_IP }
    for (let index = 0; index < 600; index++) {
      const listed = await harness.authorized('/v1/devices', { headers }, sessionToken)
      expect(listed.status).toBe(200)
    }
    const limited = await harness.authorized('/v1/devices', { headers }, sessionToken)
    expect(limited.status).toBe(429)
    const otherToken = await harness.signIn(createPushHostKeypair(68))
    expect((await harness.authorized('/v1/devices', { headers }, otherToken)).status).toBe(200)
    // The handshake bucket is untouched by any of that.
    const challenge = await harness.server.app.request('/v1/host/challenge', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ v: 1, hostPublicKeyB64: hostPublicKeyB64(createPushHostKeypair(67)) })
    })
    expect(challenge.status).toBe(200)
  })
})

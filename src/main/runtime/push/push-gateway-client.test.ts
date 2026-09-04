import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { buildPushChallengeFixture, createPushHostKeypair } from './push-host-challenge-fixtures'
import { PushGatewayClient } from './push-gateway-client'

const GATEWAY_URL = 'https://push.onorca.dev'
const NOW = 1_770_000_000_000

type Recorded = {
  url: string
  method: string
  authorization: string | null
  body: unknown
  redirect: RequestRedirect | undefined
}

function fingerprintOf(publicKey: Uint8Array): string {
  return createHash('sha256').update(publicKey).digest('base64url').slice(0, 16)
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

function createFakeGateway(
  options: { sessionTtlMs?: number; devicesStatus?: number; rejectBearer?: boolean } = {}
): {
  client: PushGatewayClient
  calls: Recorded[]
  expireSession: () => void
  now: { value: number }
} {
  const hostKeypair = createPushHostKeypair()
  const hostFingerprint = fingerprintOf(hostKeypair.publicKey)
  const now = { value: NOW }
  const calls: Recorded[] = []
  const liveTokens = new Set<string>()
  const knownRegistrations = new Set<string>()
  let issued = 0
  let pendingProof: string | null = null

  const fetchImpl = (async (input: string, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    const headers = new Headers(init?.headers)
    const body: unknown = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({
      url,
      method: init?.method ?? 'GET',
      authorization: headers.get('authorization'),
      body,
      redirect: init?.redirect
    })
    if (url.endsWith('/v1/host/challenge')) {
      const built = buildPushChallengeFixture({
        hostKeypair,
        gatewayOrigin: GATEWAY_URL,
        hostFingerprint,
        issuedAt: now.value,
        challengeId: `challenge-${++issued}`
      })
      pendingProof = built.proof
      return jsonResponse(200, built.challenge)
    }
    if (url.endsWith('/v1/host/session')) {
      const params = body as { proofB64: string }
      if (params.proofB64 !== pendingProof) {
        return jsonResponse(401, { error: 'bad_proof' })
      }
      const sessionToken = `session-${issued}`
      liveTokens.add(sessionToken)
      return jsonResponse(200, {
        sessionToken,
        expiresAt: now.value + (options.sessionTtlMs ?? 24 * 60 * 60_000),
        hostFingerprint
      })
    }
    const bearer = headers.get('authorization')?.replace('Bearer ', '') ?? ''
    if (options.rejectBearer || !liveTokens.has(bearer)) {
      return jsonResponse(401, { error: 'session_expired' })
    }
    if (url.endsWith('/v1/devices')) {
      if (options.devicesStatus) {
        return jsonResponse(options.devicesStatus, { error: 'nope' })
      }
      knownRegistrations.add('reg-1')
      return jsonResponse(200, { registrationId: 'reg-1' })
    }
    if (url.endsWith('/v1/send')) {
      return jsonResponse(200, { results: [{ registrationId: 'reg-1', status: 'queued' }] })
    }
    // Why explicit: a catch-all 204 would report every delete as accepted and
    // leave the 404 branch of deleteDevice untested.
    const deleted = /\/v1\/devices\/([^/]+)$/.exec(url)
    if (deleted && init?.method === 'DELETE') {
      const registrationId = decodeURIComponent(deleted[1] ?? '')
      return new Response(null, { status: knownRegistrations.has(registrationId) ? 204 : 404 })
    }
    throw new Error(`unexpected request: ${init?.method ?? 'GET'} ${url}`)
  }) as unknown as typeof globalThis.fetch

  return {
    client: new PushGatewayClient({
      gatewayUrl: GATEWAY_URL,
      keypair: hostKeypair,
      fetch: fetchImpl,
      now: () => now.value
    }),
    calls,
    expireSession: () => liveTokens.clear(),
    now
  }
}

const REGISTER_INPUT = {
  deviceId: 'device-1',
  platform: 'ios' as const,
  token: 'a'.repeat(64),
  apnsEnvironment: 'sandbox' as const,
  filter: { sources: ['agent-task-complete'] as const, agentStates: ['finished'] as const }
}

describe('PushGatewayClient', () => {
  it('runs the challenge handshake once and reuses the cached session', async () => {
    const gateway = createFakeGateway()

    expect(await gateway.client.registerDevice(REGISTER_INPUT)).toEqual({
      ok: true,
      registrationId: 'reg-1'
    })
    expect(
      await gateway.client.send({
        registrationIds: ['reg-1'],
        notification: {
          notificationSeq: 1,
          notificationEpoch: 'epoch-1',
          source: 'agent-task-complete',
          agentState: 'finished',
          title: 'Done',
          body: 'Body'
        }
      })
    ).toEqual({ ok: true, results: [{ registrationId: 'reg-1', status: 'queued' }] })

    const handshakes = gateway.calls.filter((call) => call.url.includes('/v1/host/'))
    expect(handshakes).toHaveLength(2)
    expect(gateway.calls.at(-1)?.authorization).toBe('Bearer session-1')
  })

  it('re-authenticates once when the gateway rejects the cached session', async () => {
    const gateway = createFakeGateway()
    await gateway.client.registerDevice(REGISTER_INPUT)
    gateway.expireSession()

    expect(await gateway.client.registerDevice(REGISTER_INPUT)).toEqual({
      ok: true,
      registrationId: 'reg-1'
    })
    expect(gateway.calls.filter((call) => call.url.endsWith('/v1/host/challenge'))).toHaveLength(2)
    expect(gateway.calls.at(-1)?.authorization).toBe('Bearer session-2')
  })

  it('re-authenticates before a session that is about to expire', async () => {
    const gateway = createFakeGateway({ sessionTtlMs: 90_000 })
    await gateway.client.registerDevice(REGISTER_INPUT)
    gateway.now.value += 60_000

    await gateway.client.registerDevice(REGISTER_INPUT)
    expect(gateway.calls.filter((call) => call.url.endsWith('/v1/host/challenge'))).toHaveLength(2)
  })

  it('shares one handshake across concurrent calls', async () => {
    const gateway = createFakeGateway()
    await Promise.all([
      gateway.client.registerDevice(REGISTER_INPUT),
      gateway.client.registerDevice(REGISTER_INPUT)
    ])
    expect(gateway.calls.filter((call) => call.url.endsWith('/v1/host/challenge'))).toHaveLength(1)
  })

  it('reports an unreachable gateway instead of throwing', async () => {
    const keypair = createPushHostKeypair()
    const client = new PushGatewayClient({
      gatewayUrl: GATEWAY_URL,
      keypair,
      fetch: vi.fn(async () => {
        throw new Error('network down')
      }) as unknown as typeof globalThis.fetch,
      now: () => NOW
    })
    expect(await client.registerDevice(REGISTER_INPUT)).toEqual({
      ok: false,
      reason: 'unreachable'
    })
  })

  it('reports a refused registration as rejected', async () => {
    const gateway = createFakeGateway({ devicesStatus: 400 })
    expect(await gateway.client.registerDevice(REGISTER_INPUT)).toEqual({
      ok: false,
      reason: 'rejected'
    })
  })

  it('never follows a redirect, on the handshake or on an authorized call', async () => {
    const gateway = createFakeGateway()

    await gateway.client.registerDevice(REGISTER_INPUT)
    await gateway.client.deleteDevice('reg-1')

    // A 307 would replay the host proof, then the phone's token, to whatever
    // origin the redirect named.
    expect(gateway.calls.length).toBeGreaterThanOrEqual(4)
    expect(gateway.calls.every((call) => call.redirect === 'error')).toBe(true)
  })

  it('reports a gateway 5xx as unreachable so the caller can retry', async () => {
    const gateway = createFakeGateway({ devicesStatus: 503 })
    expect(await gateway.client.registerDevice(REGISTER_INPUT)).toEqual({
      ok: false,
      reason: 'unreachable'
    })
  })

  it('treats a delete the gateway accepted as done', async () => {
    const gateway = createFakeGateway()
    await gateway.client.registerDevice(REGISTER_INPUT)

    expect(await gateway.client.deleteDevice('reg-1')).toEqual({ deleted: true, retryable: false })
    expect(gateway.calls.at(-1)).toMatchObject({ method: 'DELETE' })
  })

  it('treats a delete of an unknown registration as done', async () => {
    const gateway = createFakeGateway()

    expect(await gateway.client.deleteDevice('reg-gone')).toEqual({
      deleted: true,
      retryable: false
    })
  })

  it('reports a 401 that survives the forced re-auth as unreachable', async () => {
    const gateway = createFakeGateway({ rejectBearer: true })

    expect(await gateway.client.registerDevice(REGISTER_INPUT)).toEqual({
      ok: false,
      reason: 'unreachable'
    })
    // Exactly one forced re-auth, not a handshake loop.
    expect(gateway.calls.filter((call) => call.url.endsWith('/v1/host/challenge'))).toHaveLength(2)
  })

  it('keeps an unreachable-classified 401 retryable for a queued delete', async () => {
    const gateway = createFakeGateway({ rejectBearer: true })

    expect(await gateway.client.deleteDevice('reg-1')).toEqual({ deleted: false, retryable: true })
  })
})

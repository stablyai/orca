import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { buildPushChallengeFixture, createPushHostKeypair } from './push-host-challenge-fixtures'
import { PushGatewaySession, type PushSessionOutcome } from './push-gateway-session'

const GATEWAY_ORIGIN = 'https://push.onorca.dev'
const NOW = 1_770_000_000_000

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

function tokenOf(outcome: PushSessionOutcome): string | null {
  return outcome.ok ? outcome.session.token : null
}

function createSessionHarness(
  options: { sessionStatus?: number; challengeStatus?: number; wrongFingerprint?: boolean } = {}
): {
  session: PushGatewaySession
  challenges: () => number
  requests: () => number
  now: { value: number }
} {
  const hostKeypair = createPushHostKeypair()
  const hostFingerprint = createHash('sha256')
    .update(hostKeypair.publicKey)
    .digest('base64url')
    .slice(0, 16)
  const now = { value: NOW }
  let issued = 0
  let requests = 0
  let pendingProof: string | null = null

  const fetchImpl = (async (input: string, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    requests += 1
    if (url.endsWith('/v1/host/challenge')) {
      if (options.challengeStatus) {
        return jsonResponse(options.challengeStatus, { error: 'rate_limited' })
      }
      const built = buildPushChallengeFixture({
        hostKeypair,
        gatewayOrigin: GATEWAY_ORIGIN,
        hostFingerprint,
        issuedAt: now.value,
        challengeId: `challenge-${++issued}`
      })
      pendingProof = built.proof
      return jsonResponse(200, built.challenge)
    }
    if (options.sessionStatus) {
      return jsonResponse(options.sessionStatus, { error: 'nope' })
    }
    const body = init?.body ? (JSON.parse(String(init.body)) as { proofB64: string }) : null
    if (body?.proofB64 !== pendingProof) {
      return jsonResponse(401, { error: 'bad_proof' })
    }
    return jsonResponse(200, {
      sessionToken: `session-${issued}`,
      expiresAt: now.value + 24 * 60 * 60_000,
      hostFingerprint: options.wrongFingerprint ? 'someone-else' : hostFingerprint
    })
  }) as unknown as typeof globalThis.fetch

  return {
    session: new PushGatewaySession({
      origin: GATEWAY_ORIGIN,
      keypair: hostKeypair,
      fetchImpl,
      now: () => now.value
    }),
    challenges: () => issued,
    requests: () => requests,
    now
  }
}

describe('PushGatewaySession', () => {
  it('drops only the exact session that received the 401', async () => {
    const harness = createSessionHarness()
    expect(tokenOf(await harness.session.ensure(null))).toBe('session-1')

    expect(tokenOf(await harness.session.ensure('session-1'))).toBe('session-2')
    expect(tokenOf(await harness.session.ensure('session-1'))).toBe('session-2')
    expect(harness.challenges()).toBe(2)
  })

  it('shares one handshake across concurrent callers', async () => {
    const harness = createSessionHarness()

    await Promise.all([harness.session.ensure(null), harness.session.ensure(null)])
    expect(harness.challenges()).toBe(1)
  })
})

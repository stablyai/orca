import { describe, expect, it, vi } from 'vitest'
import { deriveRelayHostId } from '../mobile-cloud-relay/director/relay-http-client'
import { buildPushChallengeFixture, createPushHostKeypair } from './push-host-challenge-fixtures'
import { PushGatewaySession } from './push-gateway-session'

const ORIGIN = 'https://push.onorca.dev'

describe('PushGatewaySession clock refusals', () => {
  it('signs in again as soon as an ahead clock is set back, instead of waiting out the cache', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const keypair = createPushHostKeypair()
    const hostFingerprint = deriveRelayHostId(keypair.publicKey)
    const gatewayNow = 1_770_000_000_000
    let hostNow = gatewayNow + 3_600_000
    const paths: string[] = []
    const fetchImpl: typeof fetch = async (input) => {
      const path = new URL(input instanceof Request ? input.url : String(input)).pathname
      paths.push(path)
      const body =
        path === '/v1/host/challenge'
          ? buildPushChallengeFixture({
              hostKeypair: keypair,
              gatewayOrigin: ORIGIN,
              hostFingerprint,
              issuedAt: gatewayNow
            }).challenge
          : { sessionToken: 'session-1', expiresAt: gatewayNow + 3_600_000, hostFingerprint }
      return new Response(JSON.stringify(body), { status: 200 })
    }
    const session = new PushGatewaySession({
      origin: ORIGIN,
      keypair,
      fetchImpl,
      now: () => hostNow
    })

    expect(await session.ensure(null)).toEqual({
      ok: false,
      reason: 'rejected',
      clockSkewMs: 3_600_000
    })
    expect(session.clockSkewMs()).toBe(3_600_000)

    hostNow = gatewayNow + 1_000
    expect((await session.ensure(null)).ok).toBe(true)
    expect(session.clockSkewMs()).toBeNull()
    expect(paths).toEqual(['/v1/host/challenge', '/v1/host/challenge', '/v1/host/session'])
  })
})

describe('PushGatewaySession rate limits', () => {
  it('reports a 429 as rate limited, backs off, and logs it once until sign-in recovers', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const keypair = createPushHostKeypair()
    const hostFingerprint = deriveRelayHostId(keypair.publicKey)
    let now = 1_770_000_000_000
    let limited = true
    const paths: string[] = []
    const fetchImpl: typeof fetch = async (input) => {
      const path = new URL(input instanceof Request ? input.url : String(input)).pathname
      paths.push(path)
      if (limited) {
        return new Response('{"error":"rate_limited"}', { status: 429 })
      }
      const body =
        path === '/v1/host/challenge'
          ? buildPushChallengeFixture({
              hostKeypair: keypair,
              gatewayOrigin: ORIGIN,
              hostFingerprint,
              issuedAt: now
            }).challenge
          : { sessionToken: 'session-1', expiresAt: now + 3_600_000, hostFingerprint }
      return new Response(JSON.stringify(body), { status: 200 })
    }
    const session = new PushGatewaySession({ origin: ORIGIN, keypair, fetchImpl, now: () => now })

    expect(await session.ensure(null)).toEqual({
      ok: false,
      reason: 'unreachable',
      rateLimited: true
    })
    expect(session.signInFailure()).toBe('rate_limited')
    await session.ensure(null)
    expect(paths).toEqual(['/v1/host/challenge'])

    now += 61_000
    await session.ensure(null)
    expect(paths).toEqual(['/v1/host/challenge', '/v1/host/challenge'])
    expect(warn.mock.calls.filter(([line]) => String(line).includes('HTTP 429'))).toHaveLength(1)

    limited = false
    now += 61_000
    expect((await session.ensure(null)).ok).toBe(true)
    expect(session.signInFailure()).toBeNull()
    expect(warn).toHaveBeenLastCalledWith('[push] Signed in to the push service again')
  })
})

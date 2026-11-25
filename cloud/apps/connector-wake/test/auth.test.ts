// The two auth boundaries, in CI without workerd: the publisher's admin token and the desktop's
// wake token. test/wake-protocol.ts covers the same through the running Worker.
import { createHash, randomBytes } from 'node:crypto'
import { SignJWT, exportJWK, generateKeyPair } from 'jose'
import { describe, expect, it } from 'vitest'
import { verifyAdminRequest } from '../src/admin'
import type { Env } from '../src/env'
import { verifyWakeToken } from '../src/jwt'
import { metric } from '../src/metrics'
import { CONNECTOR_WAKE_TOKEN_AUDIENCE, CONNECTOR_WAKE_TOKEN_PURPOSE } from '../../../packages/connector-contract/src/wake-messages'
import { mintWake, newHost } from './harness'

const KEY = randomBytes(36).toString('base64url')
const NEXT = randomBytes(36).toString('base64url')
const ISSUER = 'https://connector.test.invalid'

async function adminRequest(body: string, claims: Record<string, unknown> = {}, key = KEY): Promise<Request> {
  const token = await new SignJWT({ purpose: 'connector-wake-admin', op: 'wake', bodySha256: createHash('sha256').update(body).digest('base64url'), ...claims })
    .setProtectedHeader({ alg: 'HS256' })
    .setAudience('orca-connector-wake-admin')
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime('60s')
    .sign(new TextEncoder().encode(key))
  return new Request('https://wake.test/__admin/wake', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-length': String(Buffer.byteLength(body)) },
    body
  })
}

describe('admin wake token', () => {
  const env = { WAKE_ADMIN_KEY: KEY, WAKE_ADMIN_KEY_NEXT: NEXT, WAKE_ADMIN_ISSUER: ISSUER } as Env
  const body = JSON.stringify({ hosts: [newHost().hostId] })

  it('accepts only the signed body, op and purpose, under either rotation key', async () => {
    expect(await verifyAdminRequest(env, await adminRequest(body), 'wake')).toEqual({ body: JSON.parse(body) })
    expect(await verifyAdminRequest(env, await adminRequest(body, {}, NEXT), 'wake')).not.toBeNull()
    expect(await verifyAdminRequest(env, await adminRequest(body, {}, randomBytes(36).toString('base64url')), 'wake')).toBeNull()
    expect(await verifyAdminRequest(env, await adminRequest(body, { bodySha256: createHash('sha256').update('{"hosts":[]}').digest('base64url') }), 'wake')).toBeNull()
    expect(await verifyAdminRequest(env, await adminRequest(body, { op: 'erase' }), 'wake')).toBeNull()
    expect(await verifyAdminRequest(env, await adminRequest(body, { purpose: 'edge-admin' }), 'wake')).toBeNull()
  })
})

describe('wake token', async () => {
  const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true })
  const env = { WAKE_JWKS: JSON.stringify({ keys: [{ ...(await exportJWK(publicKey)), kid: 'test', alg: 'ES256' }] }) } as Env

  it('maps a valid token to its sub:mid host id and refuses other audiences, purposes and short mids', async () => {
    const host = newHost()
    expect(await verifyWakeToken(env, await mintWake(privateKey, host))).toEqual({ ok: true, hostId: host.hostId })
    expect(await verifyWakeToken(env, await mintWake(privateKey, host, { audience: 'orca-connector' }))).toEqual({ ok: false, reason: 'invalid', code: 'aud' })
    expect(await verifyWakeToken(env, await mintWake(privateKey, host, { purpose: 'connector-host' }))).toEqual({ ok: false, reason: 'invalid', code: 'claims' })
    expect(await verifyWakeToken(env, await mintWake(privateKey, { sub: 'canary', mid: 'health', hostId: 'canary:health' }))).toEqual({ ok: false, reason: 'invalid', code: 'claims' })
  })

  // A token as auth mints it, with its times moved: auth's clock ahead of or behind this colo's.
  const now = () => Math.floor(Date.now() / 1000)
  const signed = (host: { sub: string; mid: string }, times: { iat?: number; nbf?: number; exp?: number }, kid = 'test', key = privateKey) => {
    const jwt = new SignJWT({ purpose: CONNECTOR_WAKE_TOKEN_PURPOSE, mid: host.mid, ...times })
      .setProtectedHeader({ alg: 'ES256', kid })
      .setSubject(host.sub)
      .setAudience(CONNECTOR_WAKE_TOKEN_AUDIENCE)
    if (times.exp === undefined) { jwt.setExpirationTime(now() + 300) }
    return jwt.sign(key)
  }

  it('names the check a refused token failed: clock skew (exp, nbf), key and shape', async () => {
    const host = newHost()
    const code = async (token: string) => {
      const result = await verifyWakeToken(env, token)
      return result.ok ? 'ok' : result.reason === 'invalid' ? result.code : result.reason
    }
    expect(await code(await signed(host, { iat: now() - 600, exp: now() - 300 }))).toBe('exp')
    expect(await code(await signed(host, { iat: now(), nbf: now() + 300 }))).toBe('nbf')
    // A future iat alone is accepted: jose checks iat only under maxTokenAge, which the Worker does not set.
    expect(await code(await signed(host, { iat: now() + 300 }))).toBe('ok')
    expect(await code(await signed(host, { iat: now() }, 'rotated'))).toBe('kid')
    const other = await generateKeyPair('ES256', { extractable: true })
    expect(await code(await signed(host, { iat: now() }, 'test', other.privateKey))).toBe('signature')
    expect(await code('not-a-jwt')).toBe('malformed')
    expect(await code(await signed(host, { iat: now() }))).toBe('ok')
  })

  it('writes the refusal code as its own blob, after the place, and nothing from the token', () => {
    const points: { blobs: string[] }[] = []
    const metricsEnv = { METRICS: { writeDataPoint: (point: { blobs: string[] }) => points.push(point) }, EDGE_VERSION: 'test-1' } as unknown as Env
    metric(metricsEnv, 'refuse', 1, '401', [], 'token', 'SA/GRU', 'nbf')
    metric(metricsEnv, 'socket_open', 1, 'new', [], '', 'EU/FRA')
    expect(points.map((point) => point.blobs)).toEqual([
      ['refuse', '401', 'test-1', 'token', 'SA/GRU', 'nbf'],
      ['socket_open', 'new', 'test-1', '', 'EU/FRA', '']
    ])
  })
})

// The two auth boundaries, in CI without workerd: the publisher's admin token and the desktop's
// wake token. test/wake-protocol.ts covers the same through the running Worker.
import { createHash, randomBytes } from 'node:crypto'
import { SignJWT, exportJWK, generateKeyPair } from 'jose'
import { describe, expect, it } from 'vitest'
import { verifyAdminRequest } from '../src/admin'
import type { Env } from '../src/env'
import { verifyWakeToken } from '../src/jwt'
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
    expect(await verifyWakeToken(env, await mintWake(privateKey, host, { audience: 'orca-connector' }))).toEqual({ ok: false, reason: 'invalid' })
    expect(await verifyWakeToken(env, await mintWake(privateKey, host, { purpose: 'connector-host' }))).toEqual({ ok: false, reason: 'invalid' })
    expect(await verifyWakeToken(env, await mintWake(privateKey, { sub: 'canary', mid: 'health', hostId: 'canary:health' }))).toEqual({ ok: false, reason: 'invalid' })
  })
})

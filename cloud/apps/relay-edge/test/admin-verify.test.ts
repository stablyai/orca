import { createHash, randomBytes } from 'node:crypto'
import { SignJWT } from 'jose'
import { describe, expect, it } from 'vitest'
import { verifyAdminRequest, verifyWith, type AdminOp } from '../src/admin'
import type { Env } from '../src/env'

const KEY = randomBytes(36).toString('base64url')
const NEXT = randomBytes(36).toString('base64url')
const ERASE = randomBytes(36).toString('base64url')
const ISSUER = 'https://director.test.invalid'
const ERASER = 'https://erasure.test.invalid'
const BODY = JSON.stringify({ relayHostId: 'AAAAAAAAAAAAAAAA' })
const JTI = 'jti-0123456789abcdef'

type Sign = { key?: string; issuer?: string; op?: AdminOp; jti?: unknown; body?: string }

async function sign(opts: Sign = {}): Promise<string> {
  const claims: Record<string, unknown> = {
    purpose: 'edge-admin',
    op: opts.op ?? 'drain',
    bodySha256: createHash('sha256').update(opts.body ?? BODY).digest('base64url')
  }
  if (opts.jti !== undefined) { claims.jti = opts.jti }
  const now = Math.floor(Date.now() / 1000)
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(opts.issuer ?? ISSUER)
    .setAudience('orca-relay-edge-admin')
    .setIssuedAt(now)
    .setExpirationTime(now + 60)
    .sign(new TextEncoder().encode(opts.key ?? KEY))
}

const raw = (body = BODY) => new TextEncoder().encode(body).buffer as ArrayBuffer

function request(token: string, body = BODY): Request {
  return new Request('https://edge.test/__admin/drain', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-length': String(new TextEncoder().encode(body).byteLength) },
    body
  })
}

const baseEnv = { ADMIN_SIGNING_KEY: KEY, ADMIN_ISSUER: ISSUER } as Env

describe('admin token verify (jti)', () => {

  it('binds the operation and exact body', async () => {
    expect(await verifyWith(await sign({ jti: JTI, op: 'erase' }), KEY, ISSUER, 'drain', raw())).toBeNull()
    expect(await verifyWith(await sign({ jti: JTI, body: '{}' }), KEY, ISSUER, 'drain', raw())).toBeNull()
  })
})

describe('admin request verify (keys)', () => {

  it('accepts the primary key and only a configured NEXT key', async () => {
    const env = { ...baseEnv, ADMIN_SIGNING_KEY_NEXT: NEXT } as Env
    expect(await verifyAdminRequest(env, request(await sign({ jti: JTI })), 'drain')).not.toBeNull()
    expect(await verifyAdminRequest(env, request(await sign({ jti: JTI, key: NEXT })), 'drain')).not.toBeNull()
    expect(await verifyAdminRequest(baseEnv, request(await sign({ jti: JTI, key: NEXT })), 'drain')).toBeNull()
  })

  it('the erasure keys (primary or NEXT) verify only erase, under their own issuer', async () => {
    const next = randomBytes(36).toString('base64url')
    const env = { ...baseEnv, ERASE_SIGNING_KEY: ERASE, ERASE_SIGNING_KEY_NEXT: next, ERASE_ISSUER: ERASER } as Env
    for (const key of [ERASE, next]) {
      expect(await verifyAdminRequest(env, request(await sign({ key, issuer: ERASER, op: 'erase' })), 'erase')).not.toBeNull()
      expect(await verifyAdminRequest(env, request(await sign({ key, issuer: ERASER })), 'drain')).toBeNull()
      expect(await verifyAdminRequest(env, request(await sign({ key, op: 'erase' })), 'erase')).toBeNull()
    }
  })
})

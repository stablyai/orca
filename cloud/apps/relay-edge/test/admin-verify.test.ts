import { createHash, randomBytes } from 'node:crypto'
import { SignJWT } from 'jose'
import { describe, expect, it } from 'vitest'
import { verifyAdminRequest, verifyWith, type AdminOp } from '../src/admin'
import { ADMIN_JTI_MAX, ADMIN_JTI_SLACK_MS, admitJti } from '../src/admin-jti'
import { edgeConfig, type Env } from '../src/env'

const KEY = randomBytes(36).toString('base64url')
const NEXT = randomBytes(36).toString('base64url')
const ERASE = randomBytes(36).toString('base64url')
const ISSUER = 'https://director.test.invalid'
const ERASER = 'https://erasure.test.invalid'
const BODY = JSON.stringify({ relayHostId: 'AAAAAAAAAAAAAAAA' })
const JTI = 'jti-0123456789abcdef'

type Sign = { key?: string; issuer?: string; op?: AdminOp; jti?: unknown; body?: string; iat?: number; exp?: number }

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
    .setIssuedAt(opts.iat ?? now)
    .setExpirationTime(opts.exp ?? now + 60)
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
  it('returns a replay guard for a token with a jti, bounded by exp and iat + 2 min', async () => {
    const now = Math.floor(Date.now() / 1000)
    const short = await verifyWith(await sign({ jti: JTI, iat: now, exp: now + 30 }), KEY, ISSUER, 'drain', raw())
    expect(short?.replay).toEqual({ jti: JTI, expiresAt: (now + 30) * 1000 })
    const long = await verifyWith(await sign({ jti: JTI, iat: now, exp: now + 600 }), KEY, ISSUER, 'drain', raw())
    expect(long?.replay?.expiresAt).toBe((now + 120) * 1000)
    expect(long?.body).toEqual(JSON.parse(BODY))
  })

  it('accepts a token without a jti unless required', async () => {
    const token = await sign()
    expect((await verifyWith(token, KEY, ISSUER, 'drain', raw()))?.replay).toBeNull()
    expect(await verifyWith(token, KEY, ISSUER, 'drain', raw(), true)).toBeNull()
    expect(await verifyWith(await sign({ jti: JTI }), KEY, ISSUER, 'drain', raw(), true)).not.toBeNull()
  })

  it('refuses a malformed jti', async () => {
    for (const jti of ['short', 'x'.repeat(129), 12345678901234567890, ['a'.repeat(20)]]) {
      expect(await verifyWith(await sign({ jti }), KEY, ISSUER, 'drain', raw())).toBeNull()
    }
    expect(await verifyWith(await sign({ jti: 'x'.repeat(16) }), KEY, ISSUER, 'drain', raw())).not.toBeNull()
    expect(await verifyWith(await sign({ jti: 'x'.repeat(128) }), KEY, ISSUER, 'drain', raw())).not.toBeNull()
  })

  it('still binds op, body, key and age', async () => {
    const now = Math.floor(Date.now() / 1000)
    expect(await verifyWith(await sign({ jti: JTI, op: 'erase' }), KEY, ISSUER, 'drain', raw())).toBeNull()
    expect(await verifyWith(await sign({ jti: JTI, body: '{}' }), KEY, ISSUER, 'drain', raw())).toBeNull()
    expect(await verifyWith(await sign({ jti: JTI, key: NEXT }), KEY, ISSUER, 'drain', raw())).toBeNull()
    expect(await verifyWith(await sign({ jti: JTI, iat: now - 180, exp: now + 60 }), KEY, ISSUER, 'drain', raw())).toBeNull()
  })
})

describe('admin request verify (keys)', () => {
  it('ADMIN_REQUIRE_JTI=1 refuses tokens without a jti', async () => {
    const env = { ...baseEnv, ADMIN_REQUIRE_JTI: '1' } as Env
    expect(await verifyAdminRequest(env, request(await sign()), 'drain')).toBeNull()
    expect(await verifyAdminRequest(env, request(await sign({ jti: JTI })), 'drain')).not.toBeNull()
    expect(await verifyAdminRequest(baseEnv, request(await sign()), 'drain')).not.toBeNull()
  })

  it('accepts the primary or the NEXT key, nothing else', async () => {
    const env = { ...baseEnv, ADMIN_SIGNING_KEY_NEXT: NEXT } as Env
    expect(await verifyAdminRequest(env, request(await sign({ jti: JTI })), 'drain')).not.toBeNull()
    expect(await verifyAdminRequest(env, request(await sign({ jti: JTI, key: NEXT })), 'drain')).not.toBeNull()
    expect(await verifyAdminRequest(baseEnv, request(await sign({ jti: JTI, key: NEXT })), 'drain')).toBeNull()
    const wrong = randomBytes(36).toString('base64url')
    expect(await verifyAdminRequest(env, request(await sign({ jti: JTI, key: wrong })), 'drain')).toBeNull()
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

describe('admin jti single use', () => {
  const guard = { jti: JTI, expiresAt: 10_000 }
  it('records a fresh jti and refuses it again until it lapses', () => {
    const first = admitJti(undefined, guard, 1_000)
    expect(first.outcome).toBe('fresh')
    expect(first.seen[JTI]).toBe(10_000 + ADMIN_JTI_SLACK_MS)
    expect(admitJti(first.seen, guard, 5_000).outcome).toBe('replay')
    const later = admitJti(first.seen, { jti: 'other-jti-0123456789', expiresAt: 90_000 }, 10_000 + ADMIN_JTI_SLACK_MS)
    expect(later.outcome).toBe('fresh')
    expect(Object.keys(later.seen)).toEqual(['other-jti-0123456789'])
  })

  it('refuses rather than forgets when full of live ids', () => {
    const seen = Object.fromEntries(Array.from({ length: ADMIN_JTI_MAX }, (_, i) => [`jti-${String(i).padStart(12, '0')}`, 50_000]))
    expect(admitJti(seen, guard, 1_000).outcome).toBe('jti_full')
    expect(admitJti(seen, guard, 50_000).outcome).toBe('fresh')
  })

  it('ignores inherited property names', () => {
    expect(admitJti({}, { jti: 'propertyIsEnumerable', expiresAt: 10_000 }, 1_000).outcome).toBe('fresh')
  })
})

describe('edge config (rotation keys)', () => {
  const env = (extra: Partial<Env>) =>
    ({ EDGE_BACKEND: 'object', ...baseEnv, RELAY_JWKS: '{"keys":[]}', RELAY_JWT_AUDIENCE: 'orca-relay', PING_INTERVAL_MS: '1000', SILENCE_TIMEOUT_MS: '3000', ORPHAN_GRACE_MS: '1000', ...extra }) as Env
  it('a NEXT key, if set, must be at least 32 chars', () => {
    expect(() => edgeConfig(env({ ADMIN_SIGNING_KEY_NEXT: 'short' }))).toThrow('relay_edge_config_admin_next')
    expect(() => edgeConfig(env({ ERASE_SIGNING_KEY_NEXT: 'short' }))).toThrow('relay_edge_config_erase_next')
    expect(edgeConfig(env({ ADMIN_SIGNING_KEY_NEXT: NEXT, ERASE_SIGNING_KEY_NEXT: NEXT })).backend).toBe('object')
    expect(edgeConfig(env({ ADMIN_SIGNING_KEY_NEXT: '' })).backend).toBe('object')
  })
})

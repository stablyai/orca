import { createHash, randomBytes, randomUUID, timingSafeEqual, createCipheriv, createDecipheriv } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { getConnInfo } from '@hono/node-server/conninfo'
import { isIP } from 'node:net'
import { exportJWK, generateKeyPair, importPKCS8, importSPKI, SignJWT, exportPKCS8, calculateJwkThumbprint } from 'jose'
import { z } from 'zod'

const token = () => randomBytes(32).toString('base64url')
const hash = (value: string) => createHash('sha256').update(value).digest('base64url')
const equal = (a: string, b: string) => timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)))
const str = z.string().min(1).max(2048)
const credentials = z.object({ refreshToken: str })
const accessTtl = 15 * 60_000
const refreshTtl = 30 * 86400_000

type Config = { issuer: string; clientId: string; secret: string; email: string; userId: string; dataDir: string; signingKey?: string; previousPublicKey?: string; trustProxy?: boolean }
type Session = { id: string; profile: string; expires: number; revoked: number }

export async function createService(config: Config) {
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 })
  const keyPath = join(config.dataDir, 'signing-key.pem')
  let pem = config.signingKey
  if (!pem) {
    if (!existsSync(keyPath)) {
      const pair = await generateKeyPair('ES256', { extractable: true })
      const temporary = join(config.dataDir, `.signing-key-${randomUUID()}.tmp`)
      try {
        writeFileSync(temporary, await exportPKCS8(pair.privateKey), { mode: 0o600, flag: 'wx' })
        renameSync(temporary, keyPath)
      } finally { rmSync(temporary, { force: true }) }
    }
    pem = readFileSync(keyPath, 'utf8')
  }
  const privateKey = await importPKCS8(pem, 'ES256', { extractable: true })
  const privateJwk = await exportJWK(privateKey)
  const { d: _d, ...publicJwk } = privateJwk
  const kid = await calculateJwkThumbprint(publicJwk)
  const keys = [{ ...publicJwk, kid, alg: 'ES256', use: 'sig' }]
  if (config.previousPublicKey) {
    const previous = await exportJWK(await importSPKI(config.previousPublicKey, 'ES256', { extractable: true }))
    keys.push({ ...previous, kid: await calculateJwkThumbprint(previous), alg: 'ES256', use: 'sig' })
  }
  const db = new DatabaseSync(join(config.dataDir, 'sessions.sqlite'))
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS codes (hash TEXT PRIMARY KEY, challenge TEXT NOT NULL, nonce TEXT NOT NULL, state TEXT NOT NULL, redirect TEXT NOT NULL, profile TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, profile TEXT NOT NULL, expires INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS refresh (hash TEXT PRIMARY KEY, session TEXT NOT NULL REFERENCES sessions(id), used INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS access (hash TEXT PRIMARY KEY, session TEXT NOT NULL REFERENCES sessions(id), expires INTEGER NOT NULL);`)
  const columns = db.prepare('PRAGMA table_info(refresh)').all() as { name: string }[]
  if (!columns.some(column => column.name === 'rotated_at')) db.exec('ALTER TABLE refresh ADD COLUMN rotated_at INTEGER')
  if (!columns.some(column => column.name === 'successor')) db.exec('ALTER TABLE refresh ADD COLUMN successor TEXT')
  const encryptionKey = createHash('sha256').update('orca-refresh-replay:').update(config.secret).digest()
  const seal = (value: string) => {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', encryptionKey, iv)
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url')
  }
  const unseal = (value: string) => {
    const bytes = Buffer.from(value, 'base64url'), decipher = createDecipheriv('aes-256-gcm', encryptionKey, bytes.subarray(0, 12))
    decipher.setAuthTag(bytes.subarray(12, 28))
    return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8')
  }
  const purge = () => {
    const now = Date.now()
    db.prepare('DELETE FROM codes WHERE expires<?').run(now)
    db.prepare('DELETE FROM access WHERE expires<?').run(now)
    db.prepare('UPDATE refresh SET successor=NULL WHERE rotated_at<? AND successor IS NOT NULL').run(now - 60_000)
    db.prepare('DELETE FROM refresh WHERE session IN (SELECT id FROM sessions WHERE expires<? OR revoked=1)').run(now)
    db.prepare('DELETE FROM sessions WHERE (expires<? OR revoked=1) AND NOT EXISTS (SELECT 1 FROM access WHERE access.session=sessions.id)').run(now)
    for (const [ip, entries] of attempts) if (!entries.some(t => t > now - 60_000)) attempts.delete(ip)
  }
  const app = new Hono()
  app.use('*', async (c, next) => { await next(); c.header('Cache-Control', c.req.path === '/.well-known/jwks.json' && c.res.ok ? 'public, max-age=300' : 'no-store') })
  app.use('*', bodyLimit({ maxSize: 8192, onError: () => Response.json({ error: 'request_too_large' }, { status: 413 }) }))
  const getSession = (raw: string): Session | undefined => db.prepare('SELECT s.* FROM access a JOIN sessions s ON s.id=a.session WHERE a.hash=? AND a.expires>? AND s.expires>? AND s.revoked=0').get(hash(raw), Date.now(), Date.now()) as Session | undefined
  const bearer = (header?: string) => /^Bearer ([^\s]+)$/.exec(header ?? '')?.[1] ?? ''
  const cloud = (s: Session) => ({ cloudProfileId: s.profile, userId: config.userId, email: config.email, linkedAt: Date.now() })
  const info = (s: Session) => ({ cloud: cloud(s), organizations: [], capabilities: { flags: { 'relay.use': true }, refreshedAt: Date.now() } })
  const issue = (s: Session) => {
    const accessToken = token(), refreshToken = token(), expiresAt = Date.now() + accessTtl
    db.prepare('INSERT INTO access VALUES (?,?,?)').run(hash(accessToken), s.id, expiresAt)
    db.prepare('INSERT INTO refresh (hash,session,used) VALUES (?,?,0)').run(hash(refreshToken), s.id)
    return { accessToken, refreshToken, expiresAt, ...info(s) }
  }
  const body = async (request: Request) => { try { return await request.json() } catch { return null } }
  const fail = (error: string, status: 400 | 401 | 403 | 429 | 501 = 400) => Response.json({ error }, { status, headers: { 'Cache-Control': 'no-store' } })
  const attempts = new Map<string, number[]>()
  const cleanup = setInterval(purge, 60_000); cleanup.unref()
  const authorize = z.object({ client_id: str, response_type: z.literal('code'), redirect_uri: str, nonce: str, state: str, code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/), code_challenge_method: z.literal('S256'), local_profile_id: str })
  const validAuth = (params: Record<string, string>) => {
    const parsed = authorize.safeParse(params)
    if (!parsed.success || parsed.data.client_id !== config.clientId) return null
    try { const u = new URL(parsed.data.redirect_uri); if (u.protocol !== 'http:' || u.hostname !== '127.0.0.1' || !u.port || u.pathname !== '/auth/callback' || u.search || u.hash || u.username || u.password) return null } catch { return null }
    return parsed.data
  }
  app.get('/healthz', c => c.json({ ok: true }))
  app.get('/.well-known/jwks.json', c => c.json({ keys }))
  app.get('/v1/desktop/auth/authorize', c => {
    if (!validAuth(c.req.query())) return fail('invalid_request')
    c.header('Cache-Control', 'no-store'); c.header('Content-Security-Policy', "default-src 'none'; form-action 'self' http://127.0.0.1:*; base-uri 'none'; frame-ancestors 'none'")
    return c.html('<!doctype html><title>Orca sign in</title><h1>Orca sign in</h1><form method="post"><label>Admin secret <input type="password" name="secret" required autofocus></label><button>Sign in</button></form>')
  })
  app.post('/v1/desktop/auth/authorize', async c => {
    const params = validAuth(c.req.query()); if (!params) return fail('invalid_request')
    const now = Date.now()
    let address = 'unknown'
    try { address = getConnInfo(c).remote.address ?? 'unknown' } catch { /* Non-server requests share a bucket. */ }
    if (config.trustProxy) {
      const forwarded = c.req.header('x-forwarded-for')?.split(',').at(-1)?.trim()
      if (forwarded && isIP(forwarded)) address = forwarded
    }
    const recent = (key: string) => (attempts.get(key) ?? []).filter(t => t > now - 60_000)
    const ipKey = `ip:${address}`, ipFailures = recent(ipKey), globalFailures = recent('global')
    if (ipFailures.length >= 10 || globalFailures.length >= 100) return fail('rate_limited', 429)
    let form: Record<string, unknown>
    try { form = await c.req.parseBody() } catch { return fail('invalid_request') }
    if (typeof form.secret !== 'string' || !equal(form.secret, config.secret)) {
      ipFailures.push(now); globalFailures.push(now); attempts.set(ipKey, ipFailures); attempts.set('global', globalFailures)
      return fail('invalid_credentials', 401)
    }
    const code = token()
    db.prepare('INSERT INTO codes VALUES (?,?,?,?,?,?,?)').run(hash(code), params.code_challenge, params.nonce, params.state, params.redirect_uri, params.local_profile_id, now + 300_000)
    const redirect = new URL(params.redirect_uri); redirect.searchParams.set('code', code); redirect.searchParams.set('state', params.state)
    c.header('Cache-Control', 'no-store'); c.header('Referrer-Policy', 'no-referrer')
    return c.redirect(redirect.toString(), 303)
  })
  app.post('/v1/desktop/auth/session', async c => {
    const raw = await body(c.req.raw)
    const code = z.object({ code: str }).safeParse(raw)
    const row = code.success ? db.prepare('SELECT * FROM codes WHERE hash=?').get(hash(code.data.code)) as { challenge: string; nonce: string; state: string; redirect: string; profile: string; expires: number } | undefined : undefined
    if (code.success) db.prepare('DELETE FROM codes WHERE hash=?').run(hash(code.data.code))
    const input = z.object({ code: str, codeVerifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/), nonce: str, state: str, redirectUri: str, localProfileId: str }).safeParse(raw)
    if (!input.success) return fail('invalid_request')
    const p = input.data
    if (!row || row.expires < Date.now() || !equal(row.challenge, hash(p.codeVerifier)) || !equal(row.nonce, p.nonce) || !equal(row.state, p.state) || row.redirect !== p.redirectUri || row.profile !== p.localProfileId) return fail('invalid_grant', 401)
    db.exec('BEGIN IMMEDIATE')
    try { const s = { id: randomUUID(), profile: randomUUID(), expires: Date.now() + refreshTtl, revoked: 0 }; db.prepare('INSERT INTO sessions VALUES (?,?,?,0)').run(s.id, s.profile, s.expires); const result = issue(s); db.exec('COMMIT'); return c.json(result) } catch (e) { db.exec('ROLLBACK'); throw e }
  })
  app.post('/v1/desktop/auth/refresh', async c => {
    const input = credentials.safeParse(await body(c.req.raw)); if (!input.success) return fail('invalid_request')
    db.exec('BEGIN IMMEDIATE')
    try {
      const row = db.prepare('SELECT s.*, r.used, r.rotated_at, r.successor FROM refresh r JOIN sessions s ON s.id=r.session WHERE r.hash=?').get(hash(input.data.refreshToken)) as (Session & { used: number; rotated_at: number | null; successor: string | null }) | undefined
      if (!row || row.revoked || row.expires < Date.now()) { db.exec('COMMIT'); return fail('invalid_grant', 401) }
      if (row.used) {
        if (row.rotated_at !== null && row.rotated_at + 60_000 >= Date.now() && row.successor) {
          let next: string
          try { next = unseal(row.successor) } catch { db.exec('COMMIT'); return fail('invalid_grant', 401) }
          let successor = db.prepare('SELECT used, successor FROM refresh WHERE hash=? AND session=?').get(hash(next), row.id) as { used: number; successor: string | null } | undefined
          while (successor?.used && successor.successor) {
            try { next = unseal(successor.successor) } catch { db.exec('COMMIT'); return fail('invalid_grant', 401) }
            successor = db.prepare('SELECT used, successor FROM refresh WHERE hash=? AND session=?').get(hash(next), row.id) as typeof successor
          }
          if (successor && !successor.used) {
            const accessToken = token(), expiresAt = Date.now() + accessTtl
            db.prepare('INSERT INTO access VALUES (?,?,?)').run(hash(accessToken), row.id, expiresAt)
            db.exec('COMMIT'); return c.json({ accessToken, refreshToken: next, expiresAt, ...info(row) })
          }
        }
        db.prepare('UPDATE sessions SET revoked=1 WHERE id=?').run(row.id); db.exec('COMMIT'); return fail('refresh_token_reuse', 401)
      }
      const result = issue(row)
      db.prepare('UPDATE refresh SET used=1, rotated_at=?, successor=? WHERE hash=?').run(Date.now(), seal(result.refreshToken), hash(input.data.refreshToken))
      db.exec('COMMIT'); return c.json(result)
    } catch (e) { db.exec('ROLLBACK'); throw e }
  })
  app.post('/v1/desktop/auth/capabilities', c => { const s = getSession(bearer(c.req.header('authorization'))); return s ? c.json(info(s)) : fail('unauthorized', 401) })
  app.post('/v1/desktop/auth/org', c => getSession(bearer(c.req.header('authorization'))) ? fail('organization_not_found', 403) : fail('unauthorized', 401))
  app.post('/v1/desktop/auth/profile', async c => {
    const s = getSession(bearer(c.req.header('authorization'))), input = z.object({ refreshToken: str, orgId: str.optional(), name: str.optional() }).safeParse(await body(c.req.raw))
    if (!s) return fail('unauthorized', 401); if (!input.success) return fail('invalid_request'); if (input.data.orgId) return fail('organization_not_found', 403)
    const refresh = db.prepare('SELECT session FROM refresh WHERE hash=? AND used=0').get(hash(input.data.refreshToken)) as { session: string } | undefined
    if (refresh?.session !== s.id) return fail('invalid_grant', 401)
    db.exec('BEGIN IMMEDIATE'); try { const next = { id: randomUUID(), profile: randomUUID(), expires: Date.now() + refreshTtl, revoked: 0 }; db.prepare('INSERT INTO sessions VALUES (?,?,?,0)').run(next.id, next.profile, next.expires); const result = issue(next); db.exec('COMMIT'); return c.json(result) } catch (e) { db.exec('ROLLBACK'); throw e }
  })
  app.post('/v1/desktop/auth/logout', async c => {
    const s = getSession(bearer(c.req.header('authorization'))), input = credentials.safeParse(await body(c.req.raw)); if (!s) return fail('unauthorized', 401); if (!input.success) return fail('invalid_request')
    const r = db.prepare('SELECT session FROM refresh WHERE hash=?').get(hash(input.data.refreshToken)) as { session: string } | undefined
    if (r?.session !== s.id) return fail('invalid_grant', 401)
    db.prepare('UPDATE sessions SET revoked=1 WHERE id=?').run(s.id); return c.json({ ok: true })
  })
  app.post('/v1/desktop/auth/relay-token', async c => {
    const s = getSession(bearer(c.req.header('authorization'))); if (!s) return fail('unauthorized', 401)
    const input = z.object({ relayHostId: z.string().regex(/^[A-Za-z0-9_-]{16}$/), hostPublicKeyB64: str }).safeParse(await body(c.req.raw)); if (!input.success) return fail('invalid_request')
    const raw = input.data.hostPublicKeyB64
    if (!/^[A-Za-z0-9+/]{43}=$/.test(raw)) return fail('invalid_public_key')
    const key = Buffer.from(raw, 'base64'); if (key.length !== 32 || key.toString('base64') !== raw) return fail('invalid_public_key')
    const hostId = createHash('sha256').update(key).digest('base64url').slice(0, 16)
    if (!equal(hostId, input.data.relayHostId)) return fail('host_id_mismatch')
    const exp = Math.floor(Date.now() / 1000) + 300
    const relayToken = await new SignJWT({ prof: s.profile, relayHostId: hostId, purpose: 'host-control' }).setProtectedHeader({ alg: 'ES256', kid }).setSubject(config.userId).setIssuer(config.issuer).setAudience('orca-relay').setIssuedAt().setExpirationTime(exp).sign(privateKey)
    return c.json({ relayToken, expiresAt: exp * 1000 })
  })
  app.post('/v1/desktop/auth/connector-token', c => getSession(bearer(c.req.header('authorization'))) ? fail('connector_disabled', 501) : fail('unauthorized', 401))
  return { app, close: () => { clearInterval(cleanup); db.close() } }
}

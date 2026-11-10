// Per-device Orca Cloud access for phones and other companion clients.
//   POST   /v1/device-sessions {label, platform, publicKeyB64}  (signed-in desktop only) -> {deviceSession}
//   GET    /v1/device-sessions                                  (desktop or device)       -> {deviceSessions}
//   DELETE /v1/device-sessions/:id                              (owner user, or the device itself)
//   DELETE /v1/device-sessions?pairedDeviceId=<id>              (desktop: the phone was unpaired there)
// The device keeps an Ed25519 private key and signs its own short-lived token (alg EdDSA,
// kid = session id, iss `orca-device`); the control plane stores only the public key, so a D1 leak
// grants nothing and revocation is immediate (every request re-reads the row).
import { decodeProtectedHeader, importJWK, jwtVerify } from 'jose'
import { z } from 'zod'
import type { OrgRole, SandboxCaller } from './auth'
import { tokenPredatesMemberChange } from './member-changes'

export const DEVICE_TOKEN_ISSUER = 'orca-device'
const SESSION_ID = /^ds_[A-Za-z0-9_-]{22}$/
const IDLE_EXPIRY_MS = 30 * 24 * 60 * 60_000
// The identity (org, role) is a snapshot, so it must be re-vouched by a signed-in desktop this often;
// a removed org member's phone stops working within this window even if it never goes idle.
export const MAX_UNREFRESHED_MS = 14 * 24 * 60 * 60_000
const MAX_LIVE_SESSIONS_PER_USER = 10
// Last-used is advisory; refreshing it at most every 5 min keeps D1 writes off the hot path.
const TOUCH_INTERVAL_MS = 5 * 60_000

export type DeviceSessionRow = {
  id: string
  user_id: string
  account_id: string
  org_id: string | null
  org_role: OrgRole | null
  dev: number
  label: string
  platform: 'ios' | 'android' | 'web'
  public_key: string
  paired_device_id: string | null
  created_at: number
  refreshed_at: number
  last_used_at: number | null
  expires_at: number
  revoked_at: number | null
  revoked_by: string | null
}

function isEd25519PublicKeyB64(value: string): boolean {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) {
    return false
  }
  try {
    return atob(value).length === 32
  } catch {
    return false
  }
}

export const EnrollRequestSchema = z
  .object({
    label: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .refine((value) => !/[\u0000-\u001f\u007f]/.test(value)),
    platform: z.enum(['ios', 'android', 'web']),
    publicKeyB64: z.string().refine(isEd25519PublicKeyB64, 'expected a 32-byte Ed25519 key'),
    pairedDeviceId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/).optional()
  })
  .strict()

export class DeviceSessionError extends Error {
  constructor(
    readonly code: 'forbidden' | 'not_found' | 'limit_reached' | 'conflict' | 'key_revoked' | 'stale_token',
    readonly status: number
  ) {
    super(code)
  }
}

function newSessionId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  const b64 = btoa(String.fromCharCode(...bytes))
  return `ds_${b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`
}

function base64ToBase64Url(value: string): string {
  return value.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function deviceSessionView(row: DeviceSessionRow, caller?: SandboxCaller) {
  return {
    id: row.id,
    label: row.label,
    platform: row.platform,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    expiresAt: Math.min(row.expires_at, row.refreshed_at + MAX_UNREFRESHED_MS),
    ...(caller?.deviceSessionId === row.id ? { current: true } : {})
  }
}

async function getRow(db: D1Database, id: string): Promise<DeviceSessionRow | null> {
  return (await db.prepare('SELECT * FROM device_sessions WHERE id = ?').bind(id).first<DeviceSessionRow>()) ?? null
}

function isLive(row: DeviceSessionRow, now: number): boolean {
  return row.revoked_at === null && row.expires_at > now && row.refreshed_at + MAX_UNREFRESHED_MS > now
}

/** For checks after a slow step: is the phone that started it still allowed in? */
export async function isDeviceSessionLive(db: D1Database, id: string, now: number): Promise<boolean> {
  const row = await getRow(db, id)
  return row !== null && isLive(row, now)
}

/** Dev operator tokens share `sub` values with real users; their devices live in a separate namespace. */
function ownsRow(caller: SandboxCaller, row: DeviceSessionRow): boolean {
  return row.user_id === caller.userId && row.dev === (caller.dev ? 1 : 0)
}

export async function listLiveDeviceSessions(db: D1Database, caller: SandboxCaller, now: number): Promise<DeviceSessionRow[]> {
  const { results } = await db
    .prepare('SELECT * FROM device_sessions WHERE user_id = ? AND dev = ? AND revoked_at IS NULL ORDER BY created_at')
    .bind(caller.userId, caller.dev ? 1 : 0)
    .all<DeviceSessionRow>()
  return results.filter((row) => isLive(row, now))
}

/**
 * Enrolls (or refreshes) a device for the signed-in desktop caller. Re-enrolling the same key by
 * the same user refreshes the identity snapshot (org role changes) and the idle expiry.
 */
export async function enrollDeviceSession(
  db: D1Database,
  caller: SandboxCaller,
  body: z.infer<typeof EnrollRequestSchema>,
  now: number
): Promise<DeviceSessionRow> {
  if (caller.deviceSessionId) {
    // A phone must not mint more phones: enrollment needs the user's own signed-in desktop.
    throw new DeviceSessionError('forbidden', 403)
  }
  if (await tokenPredatesMemberChange(db, caller)) {
    // Minted before auth's last role change or removal for this member: its role or membership is
    // stale, so it may neither vouch for a new phone nor refresh an existing one's snapshot.
    throw new DeviceSessionError('stale_token', 403)
  }
  const { results: sameKey } = await db
    .prepare('SELECT * FROM device_sessions WHERE public_key = ?')
    .bind(body.publicKeyB64)
    .all<DeviceSessionRow>()
  if (sameKey.some((row) => row.revoked_at !== null)) {
    // A revoked key stays revoked: a phone that lost access must come back with a new key.
    throw new DeviceSessionError('key_revoked', 409)
  }
  const existing = sameKey.find((row) => row.revoked_at === null)
  if (existing && !ownsRow(caller, existing)) {
    // Never move a key between users; the device must generate a new one.
    throw new DeviceSessionError('conflict', 409)
  }
  if (existing) {
    await db
      .prepare(
        `UPDATE device_sessions SET account_id = ?, org_id = ?, org_role = ?, label = ?, platform = ?,
           paired_device_id = COALESCE(?, paired_device_id), refreshed_at = ?, expires_at = ? WHERE id = ? AND revoked_at IS NULL`
      )
      .bind(caller.accountId, caller.orgId ?? null, caller.orgRole ?? null, body.label, body.platform, body.pairedDeviceId ?? null, now, now + IDLE_EXPIRY_MS, existing.id)
      .run()
    return (await getRow(db, existing.id))!
  }
  const id = newSessionId()
  // The limit is checked inside the insert and the live-key index rejects a racing duplicate, so two
  // concurrent enrolls cannot exceed the limit or create two rows for one key.
  let inserted: D1Result
  try {
    inserted = await db
      .prepare(
        `INSERT INTO device_sessions (id, user_id, account_id, org_id, org_role, dev, label, platform, public_key,
           paired_device_id, created_at, refreshed_at, expires_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         WHERE (SELECT COUNT(*) FROM device_sessions WHERE user_id = ? AND dev = ? AND revoked_at IS NULL
                AND expires_at > ? AND refreshed_at > ?) < ?`
      )
      .bind(
        id, caller.userId, caller.accountId, caller.orgId ?? null, caller.orgRole ?? null, caller.dev ? 1 : 0, body.label,
        body.platform, body.publicKeyB64, body.pairedDeviceId ?? null, now, now, now + IDLE_EXPIRY_MS,
        caller.userId, caller.dev ? 1 : 0, now, now - MAX_UNREFRESHED_MS, MAX_LIVE_SESSIONS_PER_USER
      )
      .run()
  } catch {
    throw new DeviceSessionError('conflict', 409)
  }
  if (!inserted.meta.changes) {
    throw new DeviceSessionError('limit_reached', 409)
  }
  console.log(JSON.stringify({ event: 'device_session_enrolled', id, platform: body.platform, by: caller.userId }))
  return (await getRow(db, id))!
}

/** The owner user may revoke any of their devices; a device may revoke only itself. */
export async function revokeDeviceSession(db: D1Database, caller: SandboxCaller, id: string, now: number): Promise<DeviceSessionRow> {
  const row = SESSION_ID.test(id) ? await getRow(db, id) : null
  if (!row || !ownsRow(caller, row) || row.revoked_at !== null) {
    throw new DeviceSessionError('not_found', 404)
  }
  if (caller.deviceSessionId && caller.deviceSessionId !== id) {
    throw new DeviceSessionError('forbidden', 403)
  }
  await db
    .prepare('UPDATE device_sessions SET revoked_at = ?, revoked_by = ? WHERE id = ? AND revoked_at IS NULL')
    .bind(now, caller.deviceSessionId ? `device:${id}` : `user:${caller.userId}`, id)
    .run()
  console.log(JSON.stringify({ event: 'device_session_revoked', id, by: caller.deviceSessionId ? 'device' : 'user' }))
  return (await getRow(db, id))!
}

/**
 * A member left or was removed from the account: every phone they enrolled there stops at once
 * (the 14-day re-vouch is only the backstop). Their workspace grants are revoked separately.
 */
export async function revokeMemberDeviceSessions(db: D1Database, accountId: string, userId: string, now: number): Promise<number> {
  const result = await db
    .prepare(`UPDATE device_sessions SET revoked_at = ?, revoked_by = 'system:member_removed' WHERE account_id = ? AND user_id = ? AND revoked_at IS NULL`)
    .bind(now, accountId, userId)
    .run()
  if (result.meta.changes > 0) {
    console.log(JSON.stringify({ event: 'device_sessions_revoked_member_removed', count: result.meta.changes }))
  }
  return result.meta.changes
}

/**
 * The member's role changed: their phones act with the new role from the next request (the stored
 * snapshot is what a device token authenticates as), so a demotion takes effect on phones too.
 */
export async function syncDeviceSessionRole(db: D1Database, accountId: string, userId: string, role: OrgRole): Promise<number> {
  const result = await db
    .prepare(
      `UPDATE device_sessions SET org_role = ?
       WHERE account_id = ? AND user_id = ? AND org_id IS NOT NULL AND revoked_at IS NULL AND (org_role IS NULL OR org_role <> ?)`
    )
    .bind(role, accountId, userId, role)
    .run()
  return result.meta.changes
}

/** True when the bearer looks like a device-signed token (cheap header check, no verification). */
export function isDeviceToken(token: string): boolean {
  try {
    const header = decodeProtectedHeader(token)
    return header.alg === 'EdDSA' && typeof header.kid === 'string' && SESSION_ID.test(header.kid)
  } catch {
    return false
  }
}

export async function authenticateDeviceToken(
  db: D1Database,
  token: string,
  audience: string,
  now: number
): Promise<SandboxCaller | null> {
  try {
    const kid = decodeProtectedHeader(token).kid
    if (typeof kid !== 'string' || !SESSION_ID.test(kid)) {
      return null
    }
    const row = await getRow(db, kid)
    if (!row || !isLive(row, now)) {
      return null
    }
    const key = await importJWK({ kty: 'OKP', crv: 'Ed25519', x: base64ToBase64Url(row.public_key) }, 'EdDSA')
    await jwtVerify(token, key, {
      algorithms: ['EdDSA'],
      issuer: DEVICE_TOKEN_ISSUER,
      audience,
      subject: row.id,
      maxTokenAge: '5m',
      requiredClaims: ['exp', 'iat'],
      currentDate: new Date(now)
    })
    if (row.last_used_at === null || now - row.last_used_at > TOUCH_INTERVAL_MS) {
      await db
        .prepare('UPDATE device_sessions SET last_used_at = ?, expires_at = ? WHERE id = ? AND revoked_at IS NULL')
        .bind(now, now + IDLE_EXPIRY_MS, row.id)
        .run()
    }
    return {
      userId: row.user_id,
      accountId: row.account_id,
      ...(row.org_id ? { orgId: row.org_id, ...(row.org_role ? { orgRole: row.org_role } : {}) } : {}),
      ...(row.dev ? { dev: true } : {}),
      deviceSessionId: row.id
    }
  } catch {
    return null
  }
}

export type DeviceSessionRouteDeps = {
  db: D1Database
  caller: SandboxCaller
  now: number
  readJson: () => Promise<unknown>
  /** Revokes the device's workspace grants (orcad devices) when its session is revoked. */
  onRevoked?: (deviceSessionId: string) => Promise<void>
}

export async function handleDeviceSessionsRoute(request: Request, url: URL, deps: DeviceSessionRouteDeps): Promise<Response> {
  const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } })
  const match = /^\/v1\/device-sessions(?:\/([A-Za-z0-9_-]+))?$/.exec(url.pathname)
  if (!match) {
    return json({ error: 'not_found' }, 404)
  }
  const [, id] = match
  try {
    if (!id && request.method === 'DELETE') {
      const pairedDeviceId = url.searchParams.get('pairedDeviceId')
      if (deps.caller.deviceSessionId || !pairedDeviceId) {
        return json({ error: deps.caller.deviceSessionId ? 'forbidden' : 'invalid_request' }, deps.caller.deviceSessionId ? 403 : 400)
      }
      const rows = (await listLiveDeviceSessions(deps.db, deps.caller, deps.now)).filter((row) => row.paired_device_id === pairedDeviceId)
      for (const row of rows) {
        await revokeDeviceSession(deps.db, deps.caller, row.id, deps.now)
        await deps.onRevoked?.(row.id).catch(() => console.log(JSON.stringify({ event: 'device_grant_revoke_failed', id: row.id })))
      }
      return json({ revoked: rows.length })
    }
    if (!id && request.method === 'GET') {
      const rows = await listLiveDeviceSessions(deps.db, deps.caller, deps.now)
      return json({ deviceSessions: rows.map((row) => deviceSessionView(row, deps.caller)) })
    }
    if (!id && request.method === 'POST') {
      const body = EnrollRequestSchema.safeParse(await deps.readJson())
      if (!body.success) {
        return json({ error: 'invalid_request' }, 400)
      }
      const row = await enrollDeviceSession(deps.db, deps.caller, body.data, deps.now)
      return json({ deviceSession: deviceSessionView(row) })
    }
    if (id && request.method === 'DELETE') {
      const row = await revokeDeviceSession(deps.db, deps.caller, id, deps.now)
      // Revocation already took effect for the control plane; grant cleanup failing must not undo it.
      await deps.onRevoked?.(row.id).catch(() => console.log(JSON.stringify({ event: 'device_grant_revoke_failed', id: row.id })))
      return json({ deviceSession: deviceSessionView(row) })
    }
    return json({ error: 'not_found' }, 404)
  } catch (error) {
    if (error instanceof DeviceSessionError) {
      return json({ error: error.code }, error.status)
    }
    throw error
  }
}

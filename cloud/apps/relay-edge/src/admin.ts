// Director → edge admin calls (phase 2). Each request carries an HS256 token signed with the
// director's edge admin key (not its assignment lease key), with its own purpose and audience (desktops never receive one)
// and the SHA-256 of the exact request body, so a token cannot authorise a different payload.
//   POST /__admin/assign  { userId, relayHostId, cellId, assignmentEpoch, devices? }
//   POST /__admin/export  { relayHostId }  freezes the host for the move away (409 while connected)
//   POST /__admin/erase   { userId, relayHostId }
//   POST /__admin/drain   { relayHostId }  sends the host's live control back to the director
// Replay: a token with a `jti` (16-128 chars) is single use, enforced by the target host's object
// (admin-jti.ts; a repeat is 409 `replay`). Transitional: a token without one is still accepted
// (metric `admin_no_jti`) until the director sends it everywhere; ADMIN_REQUIRE_JTI=1 then makes
// it mandatory (401 without).
// Key rotation (each signer takes a primary and an optional _NEXT key; either one verifies):
//   1. set ADMIN_SIGNING_KEY_NEXT (new key) on the edge and deploy;
//   2. switch the director to sign with the new key;
//   3. move the new key to ADMIN_SIGNING_KEY and clear ADMIN_SIGNING_KEY_NEXT.
// The erasure job's ERASE_SIGNING_KEY / ERASE_SIGNING_KEY_NEXT rotate the same way.
import { jwtVerify } from 'jose'
import { z } from 'zod'
import type { Env } from './env'
import type { AdminReplayGuard } from './admin-jti'

export const ADMIN_AUDIENCE = 'orca-relay-edge-admin'
export const ADMIN_PURPOSE = 'edge-admin'
export type AdminOp = 'assign' | 'export' | 'erase' | 'drain'

const HOST_ID = /^[A-Za-z0-9_-]{16}$/
const ADMIN_BODY_MAX = 256 * 1024

// One row of relay_devices, as the director reads it from Postgres (numbers as numbers).
export const DeviceRowSchema = z
  .object({
    user_id: z.string().min(1),
    relay_host_id: z.string().regex(HOST_ID),
    relay_device_id: z.string().min(1).max(128),
    current_hash: z.string().min(1).max(256),
    current_version: z.number().int().nonnegative(),
    current_expires_at: z.number().int().nonnegative(),
    grace_hash: z.string().min(1).max(256).nullable(),
    grace_version: z.number().int().nonnegative().nullable(),
    grace_expires_at: z.number().int().nonnegative().nullable(),
    revoked_at: z.number().int().nonnegative().nullable(),
    updated_at: z.number().int().nonnegative()
  })
  .strict()
export type DeviceRow = z.infer<typeof DeviceRowSchema>

export const AssignBodySchema = z
  .object({
    userId: z.string().min(1),
    relayHostId: z.string().regex(HOST_ID),
    cellId: z.string().min(1).max(64),
    assignmentEpoch: z.number().int().positive(),
    // Moving onto the edge: the host's complete device set (replaces the object's). Omitted when
    // the host moves away.
    devices: z.array(DeviceRowSchema).max(64).optional(),
    // Where to create the host's object on its first push (objects never move). Ignored afterwards.
    locationHint: z.enum(['wnam', 'enam', 'sam', 'weur', 'eeur', 'apac', 'oc', 'afr', 'me']).optional()
  })
  .strict()
  .refine((b) => (b.devices ?? []).every((d) => d.user_id === b.userId && d.relay_host_id === b.relayHostId), {
    message: 'device rows must belong to the assigned host'
  })
export type AssignBody = z.infer<typeof AssignBodySchema>

export const ExportBodySchema = z.object({ relayHostId: z.string().regex(HOST_ID) }).strict()
export const DrainBodySchema = z.object({ relayHostId: z.string().regex(HOST_ID) }).strict()
export const EraseBodySchema = z.object({ userId: z.string().min(1), relayHostId: z.string().regex(HOST_ID) }).strict()

async function sha256B64url(bytes: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  let binary = ''
  for (const byte of digest) { binary += String.fromCharCode(byte) }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export const ADMIN_TOKEN_MAX_AGE_S = 120
const JTI_MIN = 16
const JTI_MAX = 128

export type VerifiedAdmin = { body: unknown; replay: AdminReplayGuard | null }

// Signing keys shorter than 32 characters are never used (edgeConfig refuses the admin ones).
function signingKeys(...keys: (string | undefined)[]): string[] {
  return keys.filter((key): key is string => key !== undefined && key.length >= 32)
}

// Verifies the bearer token for `op` over `body`; returns the parsed body or null (401).
export async function verifyAdminRequest(env: Env, request: Request, op: AdminOp): Promise<VerifiedAdmin | null> {
  const adminIssuer = env.ADMIN_ISSUER
  if (!env.ADMIN_SIGNING_KEY || !adminIssuer) { return null }
  const auth = request.headers.get('authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  if (!token) { return null }
  const declared = Number(request.headers.get('content-length') ?? Number.NaN)
  if (!(declared >= 0 && declared <= ADMIN_BODY_MAX)) { return null }
  const raw = await request.arrayBuffer()
  if (raw.byteLength > ADMIN_BODY_MAX) { return null }
  // The director signs every op; the erasure job, with its own key and issuer, only `erase`.
  const signers = signingKeys(env.ADMIN_SIGNING_KEY, env.ADMIN_SIGNING_KEY_NEXT).map((key) => ({ key, issuer: adminIssuer }))
  if (op === 'erase' && env.ERASE_ISSUER) {
    const issuer = env.ERASE_ISSUER
    signers.push(...signingKeys(env.ERASE_SIGNING_KEY, env.ERASE_SIGNING_KEY_NEXT).map((key) => ({ key, issuer })))
  }
  const requireJti = env.ADMIN_REQUIRE_JTI === '1'
  for (const signer of signers) {
    const verified = await verifyWith(token, signer.key, signer.issuer, op, raw, requireJti)
    if (verified) { return verified }
  }
  return null
}

export async function verifyWith(
  token: string,
  key: string,
  issuer: string,
  op: AdminOp,
  raw: ArrayBuffer,
  requireJti = false
): Promise<VerifiedAdmin | null> {
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(key), {
      algorithms: ['HS256'],
      audience: ADMIN_AUDIENCE,
      issuer,
      maxTokenAge: ADMIN_TOKEN_MAX_AGE_S
    })
    if (payload.purpose !== ADMIN_PURPOSE || payload.op !== op) { return null }
    if (payload.bodySha256 !== (await sha256B64url(raw))) { return null }
    const { jti } = payload
    if (jti === undefined && requireJti) { return null }
    if (jti !== undefined && (typeof jti !== 'string' || jti.length < JTI_MIN || jti.length > JTI_MAX)) { return null }
    // maxTokenAge makes iat mandatory; the token stops verifying at exp or iat + max age.
    const lastValidS = Math.min(payload.exp ?? Number.POSITIVE_INFINITY, (payload.iat ?? 0) + ADMIN_TOKEN_MAX_AGE_S)
    const replay = jti === undefined ? null : { jti, expiresAt: lastValidS * 1000 }
    return { body: JSON.parse(new TextDecoder().decode(raw)), replay }
  } catch {
    return null
  }
}

// Connector → Worker admin call (the edge's admin.ts, one op). The request carries an HS256 token
// signed with the connector's wake admin key, with its own purpose and audience (desktops never
// receive one) and the SHA-256 of the exact request body, so a token cannot authorise a different
// payload.
//   POST /__admin/wake  { hosts: [hostId, ...] }  -> { delivered, noSocket, error }
// No jti: a replay inside the token's life only repeats a wake, which is idempotent.
// Key rotation (either key verifies):
//   1. set WAKE_ADMIN_KEY_NEXT (new key) on the Worker and deploy;
//   2. switch the connector to sign with the new key;
//   3. move the new key to WAKE_ADMIN_KEY and clear WAKE_ADMIN_KEY_NEXT.
import { jwtVerify } from 'jose'
import {
  CONNECTOR_WAKE_ADMIN_AUDIENCE,
  CONNECTOR_WAKE_ADMIN_BODY_MAX_BYTES,
  type CONNECTOR_WAKE_ADMIN_OP,
  CONNECTOR_WAKE_ADMIN_PURPOSE
} from '../../../packages/connector-contract/src/wake-messages'
import type { Env } from './env'

export type AdminOp = typeof CONNECTOR_WAKE_ADMIN_OP

// 500 host ids are ~50 KB.
const ADMIN_BODY_MAX = CONNECTOR_WAKE_ADMIN_BODY_MAX_BYTES
export const ADMIN_TOKEN_MAX_AGE_S = 120

async function sha256B64url(bytes: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  let binary = ''
  for (const byte of digest) { binary += String.fromCharCode(byte) }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// Signing keys shorter than 32 characters are never used (wakeConfig refuses them).
function signingKeys(...keys: (string | undefined)[]): string[] {
  return keys.filter((key): key is string => key !== undefined && key.length >= 32)
}

// Verifies the bearer token for `op` over the body; returns the parsed body or null (401).
export async function verifyAdminRequest(env: Env, request: Request, op: AdminOp): Promise<{ body: unknown } | null> {
  const issuer = env.WAKE_ADMIN_ISSUER
  if (!env.WAKE_ADMIN_KEY || !issuer) { return null }
  const auth = request.headers.get('authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  if (!token) { return null }
  const declared = Number(request.headers.get('content-length') ?? Number.NaN)
  if (!(declared >= 0 && declared <= ADMIN_BODY_MAX)) { return null }
  const raw = await request.arrayBuffer()
  if (raw.byteLength > ADMIN_BODY_MAX) { return null }
  for (const key of signingKeys(env.WAKE_ADMIN_KEY, env.WAKE_ADMIN_KEY_NEXT)) {
    const verified = await verifyWith(token, key, issuer, op, raw)
    if (verified) { return verified }
  }
  return null
}

export async function verifyWith(token: string, key: string, issuer: string, op: AdminOp, raw: ArrayBuffer): Promise<{ body: unknown } | null> {
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(key), {
      algorithms: ['HS256'],
      audience: CONNECTOR_WAKE_ADMIN_AUDIENCE,
      issuer,
      maxTokenAge: ADMIN_TOKEN_MAX_AGE_S
    })
    if (payload.purpose !== CONNECTOR_WAKE_ADMIN_PURPOSE || payload.op !== op) { return null }
    if (payload.bodySha256 !== (await sha256B64url(raw))) { return null }
    return { body: JSON.parse(new TextDecoder().decode(raw)) }
  } catch {
    return null
  }
}

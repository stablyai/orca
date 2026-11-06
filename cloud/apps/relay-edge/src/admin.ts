// Director → edge admin calls (phase 2). Each request carries an HS256 token signed with the
// director's assignment signing key, with its own purpose and audience (desktops never receive one)
// and the SHA-256 of the exact request body, so a token cannot authorise a different payload.
//   POST /__admin/assign  { userId, relayHostId, cellId, assignmentEpoch, devices? }
//   POST /__admin/export  { relayHostId }
//   POST /__admin/erase   { userId, relayHostId }
import { jwtVerify } from 'jose'
import { z } from 'zod'
import type { Env } from './env'

export const ADMIN_AUDIENCE = 'orca-relay-edge-admin'
export const ADMIN_PURPOSE = 'edge-admin'
export type AdminOp = 'assign' | 'export' | 'erase'

const HOST_ID = /^[A-Za-z0-9_-]{16}$/

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
    devices: z.array(DeviceRowSchema).max(64).optional()
  })
  .strict()
  .refine((b) => (b.devices ?? []).every((d) => d.user_id === b.userId && d.relay_host_id === b.relayHostId), {
    message: 'device rows must belong to the assigned host'
  })
export type AssignBody = z.infer<typeof AssignBodySchema>

export const ExportBodySchema = z.object({ relayHostId: z.string().regex(HOST_ID) }).strict()
export const EraseBodySchema = z.object({ userId: z.string().min(1), relayHostId: z.string().regex(HOST_ID) }).strict()

async function sha256B64url(bytes: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  let binary = ''
  for (const byte of digest) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// Verifies the bearer token for `op` over `body`; returns the parsed body or null (401).
export async function verifyAdminRequest(
  env: Env,
  request: Request,
  op: AdminOp
): Promise<{ body: unknown } | null> {
  if (!env.ASSIGNMENT_SIGNING_KEY || !env.ADMIN_ISSUER) return null
  const auth = request.headers.get('authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  if (!token) return null
  const raw = await request.arrayBuffer()
  if (raw.byteLength > 256 * 1024) return null
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(env.ASSIGNMENT_SIGNING_KEY), {
      algorithms: ['HS256'],
      audience: ADMIN_AUDIENCE,
      issuer: env.ADMIN_ISSUER,
      maxTokenAge: '2m'
    })
    if (payload.purpose !== ADMIN_PURPOSE || payload.op !== op) return null
    if (payload.bodySha256 !== (await sha256B64url(raw))) return null
    return { body: JSON.parse(new TextDecoder().decode(raw)) }
  } catch {
    return null
  }
}

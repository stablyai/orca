// Caller authentication.
// - Desktop: a short-lived ES256 JWT minted by Orca Cloud auth for the signed-in user
//   (aud = BILLING_JWT_AUDIENCE, purpose = 'billing'), verified against the auth JWKS — the same
//   pattern the relay uses, so billing never sees the user's refresh or access token.
// - Control plane: a static bearer secret (rotation: comma-separated), compared in constant time.
import { createLocalJWKSet, createRemoteJWKSet, jwtVerify, type JSONWebKeySet, type JWTVerifyGetKey } from 'jose'
import { z } from 'zod'
import type { Env } from './env'
import { constantTimeEqual } from './webhook-signature'

const ID = z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/)

const ClaimsSchema = z.object({
  sub: ID,
  org: ID.optional(),
  // Role in `org`. Only owners and admins may buy or manage the org's plan.
  orgRole: z.enum(['owner', 'admin', 'member']).optional(),
  email: z.string().email().max(320).optional(),
  purpose: z.literal('billing')
})

export type BillingCaller = {
  userId: string
  accountId: string
  canManage: boolean
  email?: string
}

const keySets = new Map<string, JWTVerifyGetKey>()

function keysFor(env: Env): JWTVerifyGetKey {
  const source = env.BILLING_JWKS_URL ?? `inline:${env.BILLING_JWKS ?? ''}`
  let keys = keySets.get(source)
  if (!keys) {
    keys = env.BILLING_JWKS_URL
      ? createRemoteJWKSet(new URL(env.BILLING_JWKS_URL))
      : createLocalJWKSet(JSON.parse(env.BILLING_JWKS ?? '{"keys":[]}') as JSONWebKeySet)
    keySets.set(source, keys)
  }
  return keys
}

export const DEV_ISSUER = 'orca-billing-dev-test'
let devKeys: { source: string; keys: JWTVerifyGetKey } | null = null

/** Dev operator keys; never honored when BILLING_ENV is 'prod'. */
function devKeysFor(env: Env): JWTVerifyGetKey | null {
  if (env.BILLING_ENV === 'prod' || !env.BILLING_DEV_JWKS) {
    return null
  }
  if (devKeys?.source !== env.BILLING_DEV_JWKS) {
    devKeys = {
      source: env.BILLING_DEV_JWKS,
      keys: createLocalJWKSet(JSON.parse(env.BILLING_DEV_JWKS) as JSONWebKeySet)
    }
  }
  return devKeys.keys
}

export function readBearer(value: string | null): string | null {
  return /^Bearer ([^\s]+)$/.exec(value ?? '')?.[1] ?? null
}

/** An org pays for its members; a user without an org is their own account. */
export function accountIdFor(claims: { sub: string; org?: string }): string {
  return claims.org ? `org:${claims.org}` : `user:${claims.sub}`
}

// Billing tokens re-resolve org and role from auth's org_memberships rows when minted and live 5
// minutes. Actions that spend money or change billing take only tokens minted in the last few
// minutes, so a demotion or removal stops them within that window (auth backdates iat by 30 s).
export const ADMIN_ACTION_MAX_TOKEN_AGE = '6m'

export async function authenticateDesktop(
  env: Env,
  request: Request,
  options: { maxTokenAge?: string } = {}
): Promise<BillingCaller | null> {
  const token = readBearer(request.headers.get('authorization'))
  if (!token) {
    return null
  }
  const verify = (keys: JWTVerifyGetKey, issuer: string | undefined) =>
    jwtVerify(token, keys, {
      audience: env.BILLING_JWT_AUDIENCE,
      algorithms: ['ES256'],
      // Billing tokens are minted per call; refuse anything long-lived.
      maxTokenAge: options.maxTokenAge ?? '15m',
      requiredClaims: ['exp', 'iat'],
      ...(issuer ? { issuer } : {})
    })
  try {
    let verified
    try {
      verified = await verify(keysFor(env), env.BILLING_AUTH_ISSUER)
    } catch (error) {
      // Dev only: an operator key set (its own issuer) until auth mints billing tokens.
      const dev = devKeysFor(env)
      if (!dev) {
        throw error
      }
      verified = await verify(dev, DEV_ISSUER)
    }
    const claims = ClaimsSchema.parse(verified.payload)
    return {
      userId: claims.sub,
      accountId: accountIdFor(claims),
      canManage: !claims.org || claims.orgRole === 'owner' || claims.orgRole === 'admin',
      email: claims.email
    }
  } catch {
    return null
  }
}

async function digest(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function authenticateControlPlane(env: Env, request: Request): Promise<boolean> {
  return authenticateSharedSecret(env.CONTROL_PLANE_TOKEN, request)
}

/** Orca Cloud auth -> billing membership pushes; a separate secret from the control plane's. */
export function authenticateMembershipSync(env: Env, request: Request): Promise<boolean> {
  return authenticateSharedSecret(env.MEMBERSHIP_SYNC_TOKEN, request)
}

async function authenticateSharedSecret(secret: string | undefined, request: Request): Promise<boolean> {
  const token = readBearer(request.headers.get('authorization'))
  const accepted = (secret ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length >= 32)
  if (!token || accepted.length === 0) {
    return false
  }
  // Hash both sides so the comparison is fixed-length and constant time.
  const presented = await digest(token)
  let matched = false
  for (const candidate of accepted) {
    matched = constantTimeEqual(presented, await digest(candidate)) || matched
  }
  return matched
}

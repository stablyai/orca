// Desktop callers present a short-lived ES256 JWT minted by Orca Cloud auth (aud=orca-sandbox,
// purpose=sandbox), verified against the auth JWKS — the billing Worker's pattern.
import {
  createLocalJWKSet,
  createRemoteJWKSet,
  jwtVerify,
  type JSONWebKeySet,
  type JWTVerifyGetKey
} from 'jose'
import { z } from 'zod'
import { authenticateDeviceToken, isDeviceToken } from './device-sessions'
import { tokenPredatesRemoval } from './member-changes'
import type { Env } from './env'

const ID = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_.:-]+$/)

const ClaimsSchema = z.object({
  sub: ID,
  org: ID.optional(),
  /** The caller's role in `org`, minted by Orca Cloud auth; absent means no admin rights. */
  orgRole: z.enum(['owner', 'admin', 'member']).optional(),
  /** Same role as Orca Cloud auth spells it in its tokens (`org_role`); either is accepted. */
  org_role: z.enum(['owner', 'admin', 'member']).optional(),
  /** Display name (auth sanitizes it, ≤80 chars). Untrusted text: label only, never identity. */
  name: z.string().max(200).optional(),
  purpose: z.literal('sandbox')
})

export type OrgRole = 'owner' | 'admin' | 'member'
export type SandboxCaller = {
  userId: string
  accountId: string
  orgId?: string
  orgRole?: OrgRole
  /** Dev operator token: every id lives under the `dev:` namespace. */
  dev?: boolean
  /** Set when a companion device (phone) signed this request with its own enrolled key. */
  deviceSessionId?: string
  /** Display name from the token, for labels next to the user id; never used for access. */
  name?: string
  /** Desktop tokens: when it was issued (ms), so a token older than a membership change can't write it back. */
  tokenIssuedAt?: number
}

/** One line of plain text, ≤80 chars; anything else is dropped rather than trusted. */
function displayName(value: string | undefined): string | undefined {
  const clean = value?.replace(/[\u0000-\u001f\u007f"\\]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80)
  return clean || undefined
}

const keySets = new Map<string, JWTVerifyGetKey>()

function keysFor(env: Env): JWTVerifyGetKey {
  const source = env.SANDBOX_JWKS_URL ?? `inline:${env.SANDBOX_JWKS ?? ''}`
  let keys = keySets.get(source)
  if (!keys) {
    keys = env.SANDBOX_JWKS_URL
      ? createRemoteJWKSet(new URL(env.SANDBOX_JWKS_URL))
      : createLocalJWKSet(JSON.parse(env.SANDBOX_JWKS ?? '{"keys":[]}') as JSONWebKeySet)
    keySets.set(source, keys)
  }
  return keys
}

export function readBearer(value: string | null): string | null {
  return /^Bearer ([^\s]+)$/.exec(value ?? '')?.[1] ?? null
}

/** Same account rule as billing: an org pays for its members, otherwise the user is the account. */
export function accountIdFor(claims: { sub: string; org?: string }): string {
  return claims.org ? `org:${claims.org}` : `user:${claims.sub}`
}

let stagingKeys: { source: string; keys: JWTVerifyGetKey } | null = null

/** Staging auth's keys and issuer; never honored in prod. Same accounts as billing dev (it trusts staging too). */
function stagingKeysFor(env: Env): { keys: JWTVerifyGetKey; issuer: string } | null {
  const source = env.SANDBOX_STAGING_JWKS_URL ?? (env.SANDBOX_STAGING_JWKS ? `inline:${env.SANDBOX_STAGING_JWKS}` : null)
  if (env.SANDBOX_ENV === 'prod' || !source || !env.SANDBOX_STAGING_AUTH_ISSUER) {
    return null
  }
  if (stagingKeys?.source !== source) {
    stagingKeys = {
      source,
      keys: env.SANDBOX_STAGING_JWKS_URL
        ? createRemoteJWKSet(new URL(env.SANDBOX_STAGING_JWKS_URL))
        : createLocalJWKSet(JSON.parse(env.SANDBOX_STAGING_JWKS ?? '{"keys":[]}') as JSONWebKeySet)
    }
  }
  return { keys: stagingKeys.keys, issuer: env.SANDBOX_STAGING_AUTH_ISSUER }
}

/** Dev-only operator keys (issuer DEV_TEST_ISSUER) so live tests run before Orca auth mints sandbox tokens. */
export const DEV_TEST_ISSUER = 'orca-sandbox-dev-test'
let devKeys: { source: string; keys: JWTVerifyGetKey } | null = null

async function verify(
  token: string,
  keys: JWTVerifyGetKey,
  env: Env,
  issuer: string | undefined,
  now: number
): Promise<SandboxCaller | null> {
  try {
    const { payload } = await jwtVerify(token, keys, {
      audience: env.SANDBOX_JWT_AUDIENCE,
      algorithms: ['ES256'],
      maxTokenAge: '15m',
      requiredClaims: ['exp', 'iat'],
      currentDate: new Date(now),
      ...(issuer ? { issuer } : {})
    })
    const claims = ClaimsSchema.parse(payload)
    return {
      userId: claims.sub,
      accountId: accountIdFor(claims),
      ...(typeof payload.iat === 'number' ? { tokenIssuedAt: payload.iat * 1000 } : {}),
      ...(displayName(claims.name) ? { name: displayName(claims.name) } : {}),
      ...(claims.org ? { orgId: claims.org, ...((claims.orgRole ?? claims.org_role) ? { orgRole: claims.orgRole ?? claims.org_role } : {}) } : {})
    }
  } catch {
    return null
  }
}

export async function authenticateDesktop(
  env: Env,
  request: Request,
  now: number = Date.now()
): Promise<SandboxCaller | null> {
  const token = readBearer(request.headers.get('authorization'))
  if (!token) {
    return null
  }
  if (isDeviceToken(token)) {
    return authenticateDeviceToken(env.SANDBOX_DB, token, env.SANDBOX_JWT_AUDIENCE, now)
  }
  const staging = stagingKeysFor(env)
  const caller =
    (await verify(token, keysFor(env), env, env.SANDBOX_AUTH_ISSUER, now)) ??
    (staging ? await verify(token, staging.keys, env, staging.issuer, now) : null)
  if (caller || !env.SANDBOX_DEV_JWKS || env.SANDBOX_ENV === 'prod') {
    return caller && (await tokenPredatesRemoval(env.SANDBOX_DB, caller)) ? null : caller
  }
  if (devKeys?.source !== env.SANDBOX_DEV_JWKS) {
    devKeys = {
      source: env.SANDBOX_DEV_JWKS,
      keys: createLocalJWKSet(JSON.parse(env.SANDBOX_DEV_JWKS) as JSONWebKeySet)
    }
  }
  // Dev callers land in their own account namespace so they never touch a real user's sandboxes.
  const dev = await verify(token, devKeys.keys, env, DEV_TEST_ISSUER, now)
  if (!dev) {
    return null
  }
  // Org-less dev tokens keep their historical `dev:<sub>` account; org dev tokens get `dev:org:<id>`.
  const devCaller: SandboxCaller = { ...dev, accountId: dev.orgId ? `dev:org:${dev.orgId}` : `dev:${dev.userId}`, dev: true }
  return (await tokenPredatesRemoval(env.SANDBOX_DB, devCaller)) ? null : devCaller
}

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
import type { Env } from './env'

const ID = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_.:-]+$/)

const ClaimsSchema = z.object({
  sub: ID,
  org: ID.optional(),
  purpose: z.literal('sandbox')
})

export type SandboxCaller = { userId: string; accountId: string }

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

export async function authenticateDesktop(
  env: Env,
  request: Request,
  now: number = Date.now()
): Promise<SandboxCaller | null> {
  const token = readBearer(request.headers.get('authorization'))
  if (!token) {
    return null
  }
  try {
    const { payload } = await jwtVerify(token, keysFor(env), {
      audience: env.SANDBOX_JWT_AUDIENCE,
      algorithms: ['ES256'],
      maxTokenAge: '15m',
      requiredClaims: ['exp', 'iat'],
      currentDate: new Date(now),
      ...(env.SANDBOX_AUTH_ISSUER ? { issuer: env.SANDBOX_AUTH_ISSUER } : {})
    })
    const claims = ClaimsSchema.parse(payload)
    return { userId: claims.sub, accountId: accountIdFor(claims) }
  } catch {
    return null
  }
}

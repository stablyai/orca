// Relay JWT verification: same claims, algorithm, issuer and audience as the GCE cells
// (cloud/apps/relay/src/authentication/relay-token-verifier.ts), and the same stale-if-error JWKS cache, reused
// unchanged, so an auth outage does not turn valid hosts away with 4401.
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet, type JWTVerifyGetKey } from 'jose'
import { z } from 'zod'
import { createStaleIfErrorJWKSet } from '../../relay/src/authentication/stale-if-error-jwks'
import type { EdgeClaims, Env } from './env'

export const HOST_ID = /^[A-Za-z0-9_-]{16}$/

const ClaimsSchema = z.object({
  sub: z.string().min(1),
  prof: z.string().min(1),
  org: z.string().min(1).optional(),
  relayHostId: z.string().regex(HOST_ID),
  purpose: z.literal('host-control'),
  exp: z.number().int().positive()
})

// Per isolate: the Worker and each object keep their own cache, keyed by where the keys come from.
const keySets = new Map<string, JWTVerifyGetKey>()

function keysFor(env: Env): JWTVerifyGetKey {
  const source = env.RELAY_JWKS_URL ?? `inline:${env.RELAY_JWKS ?? ''}`
  let keys = keySets.get(source)
  if (!keys) {
    keys = env.RELAY_JWKS_URL
      ? createStaleIfErrorJWKSet(new URL(env.RELAY_JWKS_URL))
      : createLocalJWKSet(JSON.parse(env.RELAY_JWKS ?? '{"keys":[]}') as JSONWebKeySet)
    keySets.set(source, keys)
  }
  return keys
}

export async function verifyRelayJwt(env: Env, token: string): Promise<EdgeClaims | null> {
  try {
    const { payload } = await jwtVerify(token, keysFor(env), {
      audience: env.RELAY_JWT_AUDIENCE,
      algorithms: ['ES256'],
      ...(env.RELAY_AUTH_ISSUER ? { issuer: env.RELAY_AUTH_ISSUER } : {})
    })
    const claims = ClaimsSchema.parse(payload)
    return {
      userId: claims.sub,
      profileId: claims.prof,
      organizationId: claims.org ?? '',
      relayHostId: claims.relayHostId,
      exp: claims.exp * 1000
    }
  } catch {
    return null
  }
}

export function readBearer(value: string | null): string | null {
  return /^Bearer ([^\s]+)$/.exec(value ?? '')?.[1] ?? null
}

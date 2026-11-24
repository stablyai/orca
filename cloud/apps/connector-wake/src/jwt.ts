// Wake token verification, checked at upgrade only (design §2.2): a wake-scoped token from auth,
// never the connector token. Same stale-if-error key cache as the edge, plus the colo's last good
// set (jwks-persist.ts); "could not get keys" is reported apart from "token invalid".
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet, type JWTVerifyGetKey } from 'jose'
import { z } from 'zod'
import { createStaleIfErrorJWKSet } from '../../relay/src/authentication/stale-if-error-jwks'
import { KeysUnavailableError, persistingFetch, withPersistedFallback } from './jwks-persist'
import type { Env } from './env'
import { isHostId } from './host-id'
import { CONNECTOR_WAKE_TOKEN_AUDIENCE, CONNECTOR_WAKE_TOKEN_PURPOSE } from '../../../packages/connector-contract/src/wake-messages'

const ClaimsSchema = z.object({
  sub: z.string().min(1),
  mid: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
  purpose: z.literal(CONNECTOR_WAKE_TOKEN_PURPOSE),
  exp: z.number().int().positive()
})

// Per isolate, keyed by where the keys come from.
const keySets = new Map<string, JWTVerifyGetKey>()

function keysFor(env: Env): JWTVerifyGetKey {
  const source = env.WAKE_JWKS_URL ?? `inline:${env.WAKE_JWKS ?? ''}`
  let keys = keySets.get(source)
  if (!keys) {
    const url = env.WAKE_JWKS_URL
    keys = url
      ? withPersistedFallback(url, createStaleIfErrorJWKSet(new URL(url), { fetch: persistingFetch(url) }))
      : createLocalJWKSet(JSON.parse(env.WAKE_JWKS ?? '{"keys":[]}') as JSONWebKeySet)
    keySets.set(source, keys)
  }
  return keys
}

export type WakeTokenResult = { ok: true; hostId: string } | { ok: false; reason: 'invalid' | 'keys_unavailable' }

export async function verifyWakeToken(env: Env, token: string): Promise<WakeTokenResult> {
  try {
    const { payload } = await jwtVerify(token, keysFor(env), {
      audience: CONNECTOR_WAKE_TOKEN_AUDIENCE,
      algorithms: ['ES256'],
      ...(env.WAKE_AUTH_ISSUER ? { issuer: env.WAKE_AUTH_ISSUER } : {})
    })
    const claims = ClaimsSchema.parse(payload)
    const hostId = `${claims.sub}:${claims.mid}`
    return isHostId(hostId) ? { ok: true, hostId } : { ok: false, reason: 'invalid' }
  } catch (error) {
    return { ok: false, reason: error instanceof KeysUnavailableError ? 'keys_unavailable' : 'invalid' }
  }
}

export function readBearer(value: string | null): string | null {
  return /^Bearer ([^\s]+)$/.exec(value ?? '')?.[1] ?? null
}

// Wake token verification, checked at upgrade only (design §2.2): a wake-scoped token from auth,
// never the connector token. Same stale-if-error key cache as the edge, plus the colo's last good
// set (jwks-persist.ts); "could not get keys" is reported apart from "token invalid".
import { createLocalJWKSet, errors, jwtVerify, type JSONWebKeySet, type JWTVerifyGetKey } from 'jose'
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

// Why a token was refused, from a fixed set (the refuse metric's detail): the claim or check jose
// failed on, never anything read from the token. exp/nbf/iat point at clock skew between auth and
// this colo, aud/iss at a token minted for something else, signature/kid at a key set mismatch.
export const WAKE_REFUSE_CODES = ['missing', 'exp', 'nbf', 'iat', 'aud', 'iss', 'sub', 'claims', 'signature', 'kid', 'alg', 'malformed', 'host', 'other'] as const
export type WakeRefuseCode = (typeof WAKE_REFUSE_CODES)[number]
const CHECKED_CLAIMS = new Set<string>(['exp', 'nbf', 'iat', 'aud', 'iss', 'sub'])

export function refuseCode(error: unknown): WakeRefuseCode {
  if (error instanceof errors.JWTExpired) { return 'exp' }
  if (error instanceof errors.JWTClaimValidationFailed) {
    return CHECKED_CLAIMS.has(error.claim) ? (error.claim as WakeRefuseCode) : 'claims'
  }
  if (error instanceof errors.JWSSignatureVerificationFailed) { return 'signature' }
  if (error instanceof errors.JWKSNoMatchingKey || error instanceof errors.JWKSMultipleMatchingKeys) { return 'kid' }
  if (error instanceof errors.JOSEAlgNotAllowed) { return 'alg' }
  if (error instanceof errors.JWSInvalid || error instanceof errors.JWTInvalid || error instanceof errors.JOSENotSupported) { return 'malformed' }
  if (error instanceof z.ZodError) { return 'claims' }
  return 'other'
}

export type WakeTokenResult =
  | { ok: true; hostId: string }
  | { ok: false; reason: 'invalid'; code: WakeRefuseCode }
  | { ok: false; reason: 'keys_unavailable' }

export async function verifyWakeToken(env: Env, token: string): Promise<WakeTokenResult> {
  try {
    const { payload } = await jwtVerify(token, keysFor(env), {
      audience: CONNECTOR_WAKE_TOKEN_AUDIENCE,
      algorithms: ['ES256'],
      ...(env.WAKE_AUTH_ISSUER ? { issuer: env.WAKE_AUTH_ISSUER } : {})
    })
    const claims = ClaimsSchema.parse(payload)
    const hostId = `${claims.sub}:${claims.mid}`
    return isHostId(hostId) ? { ok: true, hostId } : { ok: false, reason: 'invalid', code: 'host' }
  } catch (error) {
    return error instanceof KeysUnavailableError
      ? { ok: false, reason: 'keys_unavailable' }
      : { ok: false, reason: 'invalid', code: refuseCode(error) }
  }
}

export function readBearer(value: string | null): string | null {
  return /^Bearer ([^\s]+)$/.exec(value ?? '')?.[1] ?? null
}

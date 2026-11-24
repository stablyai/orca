// Last good relay JWKS, kept in the colo's Cache API (shared by every isolate in the colo, no object
// storage writes). A fresh isolate whose fetch of the keys fails falls back to it, so a cold isolate
// during an auth outage does not refuse valid desktops. Never used while auth answers: a fetched
// set always wins, and a token whose key the stored set lacks reads as "keys unavailable", not invalid.
import { createLocalJWKSet, type FetchImplementation, type JSONWebKeySet, type JWTVerifyGetKey } from 'jose'

// The same 30 min the cells trust a stale key set for: a rotated or leaked key is not trusted
// longer here during an auth outage. Covers only isolates that have no set at all, and never
// extends a live socket past its token's own expiry (+60 s grace).
export const PERSISTED_JWKS_MAX_STALE_MS = 30 * 60 * 1000
const STORED_AT_HEADER = 'x-orca-jwks-stored-at'

function edgeCache(): Cache | null {
  try {
    return typeof caches === 'undefined' ? null : (caches as unknown as { default: Cache }).default
  } catch {
    return null
  }
}

function isKeySet(value: unknown): value is JSONWebKeySet {
  return typeof value === 'object' && value !== null && Array.isArray((value as { keys?: unknown }).keys)
}

// The key set's fetch, plus a copy of every 200 answer into the Cache API (best effort; never fails a fetch).
export function persistingFetch(url: string): FetchImplementation {
  return async (target, options) => {
    const response = await fetch(target, options)
    if (response.status !== 200) { return response }
    const body = await response.text()
    const cache = edgeCache()
    if (cache) {
      try {
        if (isKeySet(JSON.parse(body))) {
          await cache.put(
            new Request(url),
            new Response(body, {
              headers: {
                'content-type': 'application/json',
                'cache-control': `max-age=${PERSISTED_JWKS_MAX_STALE_MS / 1000}`,
                [STORED_AT_HEADER]: String(Date.now())
              }
            })
          )
        }
      } catch {
        // Persistence is a fallback only.
      }
    }
    return new Response(body, { status: 200, headers: response.headers })
  }
}

export async function readPersistedJwks(url: string, now = Date.now()): Promise<JSONWebKeySet | null> {
  const cache = edgeCache()
  if (!cache) { return null }
  try {
    const stored = await cache.match(new Request(url))
    const storedAt = Number(stored?.headers.get(STORED_AT_HEADER))
    if (!stored || !Number.isFinite(storedAt) || now - storedAt > PERSISTED_JWKS_MAX_STALE_MS) { return null }
    const jwks: unknown = await stored.json()
    return isKeySet(jwks) ? jwks : null
  } catch {
    return null
  }
}

// The verifier could not obtain keys to judge the token: not a verdict on the token.
export class KeysUnavailableError extends Error {
  constructor() {
    super('relay_jwks_unavailable')
  }
}

function isVerdict(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  return code === 'ERR_JWKS_NO_MATCHING_KEY' || code === 'ERR_JWKS_MULTIPLE_MATCHING_KEYS'
}

// Wraps the remote (stale-if-error) key lookup: a set auth served decides; anything else (fetch
// error, timeout, non-200, unparsable set) tries the persisted set and otherwise throws
// KeysUnavailableError.
export function withPersistedFallback(url: string, remote: JWTVerifyGetKey): JWTVerifyGetKey {
  return async (protectedHeader, token) => {
    try {
      return await remote(protectedHeader, token)
    } catch (error) {
      if (isVerdict(error)) { throw error }
      const persisted = await readPersistedJwks(url)
      if (!persisted) { throw new KeysUnavailableError() }
      try {
        return await createLocalJWKSet(persisted)(protectedHeader, token)
      } catch {
        // An old stored set lacking a rotated key is not an answer from auth.
        throw new KeysUnavailableError()
      }
    }
  }
}

import {
  createLocalJWKSet,
  createRemoteJWKSet,
  customFetch,
  errors,
  jwksCache,
  type FetchImplementation,
  type JSONWebKeySet,
  type JWKSCacheInput,
  type JWTVerifyGetKey
} from 'jose'

// What the verifier and local readiness use: a key lookup, the cached set, and a refetch.
export type RelayJWKSet = JWTVerifyGetKey & {
  jwks: () => JSONWebKeySet | undefined
  reload: () => Promise<void>
}

// Auth signs every relay token with one key and serves it with no overlap on rotation, and a
// relay token lives 5 min. Past ~16 min of a full auth outage (10 min cache age plus a token's
// life and the cell's 60 s expiry grace) no token the stale keys could accept is still valid;
// the bound covers that with margin and caps how long a rotated-out (say, leaked) key stays
// trusted on a cell that cannot reach auth, including one an attacker keeps auth from.
// Emergency purge: restarting the process drops the set, and it then fails closed until a fetch
// succeeds (see "Auth outage and host token keys" in cloud/docs/orca-relay-operations.md).
export const RELAY_JWKS_MAX_STALE_MS = 30 * 60 * 1000
// After a failed fetch, verifies use the stale set without waiting on another fetch's timeout.
const FETCH_RETRY_AFTER_MS = 30 * 1000

// jose's remote set, except that a failed refetch falls back to the last set auth served, for
// a bounded time: an auth outage must not turn every still-valid token into a 4401.
export function createStaleIfErrorJWKSet(
  url: URL,
  options: {
    maxStaleMs?: number
    fetch?: FetchImplementation
  } = {}
): RelayJWKSet {
  const maxStaleMs = options.maxStaleMs ?? RELAY_JWKS_MAX_STALE_MS
  // jose stamps this with the set and the time each time a fetched set is applied.
  const cache: JWKSCacheInput = {}
  let failedAt: number | undefined
  let stale: { fetchedAt: number; keys: ReturnType<typeof createLocalJWKSet> } | undefined
  const remote = createRemoteJWKSet(url, {
    [jwksCache]: cache,
    ...(options.fetch ? { [customFetch]: options.fetch } : {})
  })
  const staleKeys = (): ReturnType<typeof createLocalJWKSet> | undefined => {
    const { uat, jwks } = cache
    if (uat === undefined || jwks === undefined || Date.now() - uat > maxStaleMs) return undefined
    if (stale?.fetchedAt !== uat) stale = { fetchedAt: uat, keys: createLocalJWKSet(jwks) }
    return stale.keys
  }
  const getKey: JWTVerifyGetKey = async (protectedHeader, token) => {
    const keys = staleKeys()
    if (keys && failedAt !== undefined && Date.now() - failedAt < FETCH_RETRY_AFTER_MS) {
      return await keys(protectedHeader, token)
    }
    try {
      const key = await remote(protectedHeader, token)
      failedAt = undefined
      return key
    } catch (error) {
      // A set auth did serve that lacks the key is an answer, not an outage.
      if (error instanceof errors.JWKSNoMatchingKey) throw error
      const fallback = staleKeys()
      if (!fallback) throw error
      failedAt = Date.now()
      return await fallback(protectedHeader, token)
    }
  }
  return Object.assign(getKey, { jwks: () => remote.jwks(), reload: () => remote.reload() })
}

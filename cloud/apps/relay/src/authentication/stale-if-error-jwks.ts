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

// Auth rotates without key overlap: 10min cache + 5min token + 60s grace expires legitimate stale-key tokens by ~16min.
// 30min caps trust in rotated/leaked keys during outages or isolation; restart purges cache and fails closed until fetch succeeds (orca-relay-operations.md).
export const RELAY_JWKS_MAX_STALE_MS = 30 * 60 * 1000
// After a failed fetch, verifies use the stale set without waiting on another fetch's timeout.
const FETCH_RETRY_AFTER_MS = 30 * 1000

// Bounded stale-key fallback prevents auth outages refusing otherwise valid tokens with 4401.
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

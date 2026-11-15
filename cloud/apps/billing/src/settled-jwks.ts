// WORKER-XREQ-PROMISE: jose's createRemoteJWKSet shares one in-flight JWKS fetch across every caller. In a
// Worker that fetch belongs to the request that started it; if that request is cancelled mid-fetch, the
// shared promise never settles and every request verifying a token behind it hangs (seen as creates stuck
// before any log, about ten minutes after a deploy: jose's cache age). This keeps the fetched key set as a
// value and lets each request that needs a fresh one fetch it for itself.
import { createLocalJWKSet, type JSONWebKeySet, type JWTVerifyGetKey } from 'jose'

export type SettledJwksOptions = {
  /** Refetch after this long (jose's default too). */
  maxAgeMs?: number
  /** An unknown `kid` refetches at most this often. */
  cooldownMs?: number
  fetch?: typeof fetch
  now?: () => number
  timeoutMs?: number
}

export function settledRemoteJWKSet(url: URL, options: SettledJwksOptions = {}): JWTVerifyGetKey {
  const maxAge = options.maxAgeMs ?? 10 * 60_000
  const cooldown = options.cooldownMs ?? 30_000
  const now = options.now ?? Date.now
  const doFetch = options.fetch ?? fetch
  let settled: { at: number; keys: JWTVerifyGetKey } | null = null
  const load = async (): Promise<JWTVerifyGetKey> => {
    const response = await doFetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(options.timeoutMs ?? 5_000) })
    if (!response.ok) {
      throw new Error(`jwks fetch failed (${response.status})`)
    }
    const keys = createLocalJWKSet((await response.json()) as JSONWebKeySet)
    settled = { at: now(), keys }
    return keys
  }
  return async (header, token) => {
    const current = settled
    if (!current || now() - current.at >= maxAge) {
      return (await load())(header, token)
    }
    try {
      return await current.keys(header, token)
    } catch (error) {
      // A rotated key: look once more, at most every cooldown.
      if (now() - current.at < cooldown) {
        throw error
      }
      return (await load())(header, token)
    }
  }
}

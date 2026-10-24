import { createHash } from 'node:crypto'
import type {
  AntigravityCredentialIdentity,
  AntigravityNativeCredential
} from './native-credential-codec'

// Why: agy >= 1.4.7 stores `id_token_email` instead of the signed `id_token`, and Google's
// refresh responses carry no new `id_token`. Without a local `sub`, every silent access-token
// refresh made the selected account look like a different one (#31579). Google's own tokeninfo
// endpoint reports the stable `sub` for the access token agy already holds, so the identity is
// still Google's, never derived from rotating secrets or an email.
const TOKENINFO_URL = 'https://oauth2.googleapis.com/tokeninfo'
const GOOGLE_ISSUER = 'https://accounts.google.com'
const MAX_CACHE_ENTRIES = 16
const MAX_RESPONSE_BYTES = 64 * 1024

export type AntigravityIdentityResolver = (
  credential: AntigravityNativeCredential
) => Promise<AntigravityCredentialIdentity | null>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readAccessToken(contents: string): string | null {
  try {
    const value: unknown = JSON.parse(contents)
    if (!isRecord(value) || !isRecord(value.token)) {
      return null
    }
    const token = value.token.access_token
    return typeof token === 'string' && token.trim() && !/\s/.test(token) ? token : null
  } catch {
    return null
  }
}

/** Accept only a live Google answer that names one stable account. */
export function parseGoogleTokeninfo(value: unknown): AntigravityCredentialIdentity | null {
  if (!isRecord(value) || typeof value.sub !== 'string' || !value.sub.trim()) {
    return null
  }
  const expiresIn = Number(value.expires_in)
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
    return null
  }
  const verified = value.email_verified === true || value.email_verified === 'true'
  return {
    issuer: GOOGLE_ISSUER,
    subject: value.sub,
    email: verified && typeof value.email === 'string' && value.email.trim() ? value.email : null
  }
}

export function createGoogleTokeninfoIdentityResolver(
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 5_000
): AntigravityIdentityResolver {
  // Keyed by a hash so the cache never holds the token itself; a refresh changes the key.
  const cache = new Map<string, AntigravityCredentialIdentity | null>()
  return async (credential) => {
    if (credential.identity) {
      return credential.identity
    }
    const accessToken = readAccessToken(credential.contents)
    if (!accessToken) {
      return null
    }
    const key = createHash('sha256').update(accessToken).digest('hex')
    if (cache.has(key)) {
      return cache.get(key) ?? null
    }
    let identity: AntigravityCredentialIdentity | null = null
    try {
      const response = await fetchImpl(TOKENINFO_URL, {
        method: 'POST',
        redirect: 'error',
        headers: {
          accept: 'application/json',
          'content-type': 'application/x-www-form-urlencoded'
        },
        // The token travels only in the HTTPS body to Google, never in the URL.
        body: new URLSearchParams({ access_token: accessToken }).toString(),
        signal: AbortSignal.timeout(timeoutMs)
      })
      if (response.ok) {
        const text = await response.text()
        if (Buffer.byteLength(text) <= MAX_RESPONSE_BYTES) {
          identity = parseGoogleTokeninfo(JSON.parse(text))
        }
      }
    } catch {
      identity = null
    }
    if (cache.size >= MAX_CACHE_ENTRIES) {
      cache.clear()
    }
    cache.set(key, identity)
    return identity
  }
}

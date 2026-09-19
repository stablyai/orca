/**
 * Parses the OAuth credential the Antigravity CLI (`agy`) persists for itself.
 *
 * Two storage encodings exist for the same payload: plain JSON, and the
 * zalando/go-keyring convention of `go-keyring-base64:` followed by base64(JSON)
 * that `agy` uses when it writes through an OS keyring.
 */

const GO_KEYRING_BASE64_PREFIX = 'go-keyring-base64:'

export type AntigravityOAuthCredential = {
  accessToken: string
  /** Unix ms; NaN-safe. `null` when the stored value has no parseable expiry. */
  expiresAt: number | null
}

function decodeStoredBlob(raw: string): unknown {
  const trimmed = raw.trim()
  const payload = trimmed.startsWith(GO_KEYRING_BASE64_PREFIX)
    ? Buffer.from(trimmed.slice(GO_KEYRING_BASE64_PREFIX.length), 'base64').toString('utf8')
    : trimmed
  try {
    return JSON.parse(payload) as unknown
  } catch {
    return null
  }
}

export function parseAntigravityOAuthCredential(raw: string): AntigravityOAuthCredential | null {
  const parsed = decodeStoredBlob(raw)
  if (!parsed || typeof parsed !== 'object') {
    return null
  }
  // Why: `agy` nests the OAuth grant under `token`, but older writes stored it flat.
  const nested = (parsed as { token?: unknown }).token
  const token = (nested && typeof nested === 'object' ? nested : parsed) as {
    access_token?: unknown
    expiry?: unknown
  }
  if (typeof token.access_token !== 'string' || token.access_token.length === 0) {
    return null
  }
  const expiryMs = typeof token.expiry === 'string' ? new Date(token.expiry).getTime() : Number.NaN
  return {
    accessToken: token.access_token,
    expiresAt: Number.isNaN(expiryMs) ? null : expiryMs
  }
}

/** An unknown expiry is treated as usable; the API call is the authority on a dead token. */
export function isAntigravityCredentialExpired(
  credential: AntigravityOAuthCredential,
  now: number = Date.now()
): boolean {
  return credential.expiresAt !== null && credential.expiresAt <= now
}

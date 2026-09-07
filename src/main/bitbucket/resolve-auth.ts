import {
  DEFAULT_API_BASE_URL,
  envValue,
  getEnvAuthConfig,
  hasAuth,
  type BitbucketAuthConfig
} from './bitbucket-auth-config'
import {
  getStoredBitbucketMetadata,
  loadStoredBitbucketSecret,
  type BitbucketStoredMetadata,
  type BitbucketStoredSecret
} from './credential-store'

/**
 * Why (STA-3941): the encrypted envelope is authoritative for auth. Plaintext
 * metadata is only consulted for credentials written before the envelope
 * carried these fields, so a torn write between the two files degrades to stale
 * display data rather than a secret paired with the wrong email.
 */
export function storedAuthConfig(
  metadata: BitbucketStoredMetadata | null,
  secret: BitbucketStoredSecret
): BitbucketAuthConfig {
  const authMode = secret.authMode ?? metadata?.authMode ?? null
  const email = secret.authMode ? (secret.email ?? null) : (metadata?.email ?? null)
  const baseUrl = secret.authMode ? (secret.baseUrl ?? null) : (metadata?.baseUrl ?? null)
  return {
    // Why: an explicit ORCA_BITBUCKET_API_BASE_URL still wins even when the
    // credential itself is stored — env precedence is per-setting, not all-or-nothing.
    baseUrl: envValue('ORCA_BITBUCKET_API_BASE_URL') ?? baseUrl ?? DEFAULT_API_BASE_URL,
    accessToken: authMode === 'token' ? secret.accessToken : null,
    email: authMode === 'basic' ? email : null,
    apiToken: authMode === 'basic' ? secret.apiToken : null
  }
}

// Env vars win over in-app credentials so existing headless/SSH setups keep
// working unchanged. The stored secret is decrypted lazily and only here, on a
// real API call — never on a status read.
export function resolveBitbucketAuthConfig(): BitbucketAuthConfig {
  const env = getEnvAuthConfig()
  if (hasAuth(env)) {
    return env
  }
  try {
    const secret = loadStoredBitbucketSecret({ force: true })
    return secret ? storedAuthConfig(getStoredBitbucketMetadata(), secret) : env
  } catch {
    // Decryption denied or unavailable: fall through as unauthenticated.
    return env
  }
}

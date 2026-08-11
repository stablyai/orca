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

export function storedAuthConfig(
  metadata: BitbucketStoredMetadata,
  secret: BitbucketStoredSecret
): BitbucketAuthConfig {
  return {
    // Why: an explicit ORCA_BITBUCKET_API_BASE_URL still wins even when the
    // credential itself is stored — env precedence is per-setting, not all-or-nothing.
    baseUrl: envValue('ORCA_BITBUCKET_API_BASE_URL') ?? metadata.baseUrl ?? DEFAULT_API_BASE_URL,
    accessToken: metadata.authMode === 'token' ? secret.accessToken : null,
    email: metadata.authMode === 'basic' ? metadata.email : null,
    apiToken: metadata.authMode === 'basic' ? secret.apiToken : null
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
  const metadata = getStoredBitbucketMetadata()
  if (!metadata) {
    return env
  }
  try {
    const secret = loadStoredBitbucketSecret({ force: true })
    return secret ? storedAuthConfig(metadata, secret) : env
  } catch {
    // Decryption denied or unavailable: fall through as unauthenticated.
    return env
  }
}

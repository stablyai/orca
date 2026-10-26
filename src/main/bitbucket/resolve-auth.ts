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

/** Envelope auth fields prevent torn writes from pairing a new secret with stale identity metadata. */
export function storedAuthConfig(
  metadata: BitbucketStoredMetadata | null,
  secret: BitbucketStoredSecret
): BitbucketAuthConfig {
  const authMode = secret.authMode ?? metadata?.authMode ?? null
  const email = secret.authMode ? (secret.email ?? null) : (metadata?.email ?? null)
  const baseUrl = secret.authMode ? (secret.baseUrl ?? null) : (metadata?.baseUrl ?? null)
  return {
    // The environment base URL overrides stored credentials independently.
    baseUrl: envValue('ORCA_BITBUCKET_API_BASE_URL') ?? baseUrl ?? DEFAULT_API_BASE_URL,
    accessToken: authMode === 'token' ? secret.accessToken : null,
    email: authMode === 'basic' ? email : null,
    apiToken: authMode === 'basic' ? secret.apiToken : null
  }
}

// Preserve environment auth precedence; decrypt stored secrets only for API calls.
export function resolveBitbucketAuthConfig(): BitbucketAuthConfig {
  const env = getEnvAuthConfig()
  if (hasAuth(env)) {
    return env
  }
  try {
    const secret = loadStoredBitbucketSecret({ force: true })
    return secret ? storedAuthConfig(getStoredBitbucketMetadata(), secret) : env
  } catch {
    return env
  }
}

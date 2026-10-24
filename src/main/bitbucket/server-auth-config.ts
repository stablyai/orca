import { envValue } from './bitbucket-auth-config'
import {
  getStoredBitbucketServerMetadata,
  hasStoredBitbucketServerCredential,
  loadStoredBitbucketServerSecret
} from './server-credential-store'

export type BitbucketServerAuthConfig = {
  baseUrl: string | null
  accessToken: string | null
}

export function normalizeBitbucketServerBaseUrl(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? ''
  if (!trimmed) {
    return null
  }
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return null
  }
  // Why: users paste REST or browser URLs; the server root is everything before /rest/.
  const path = url.pathname.replace(/\/rest(\/.*)?$/i, '').replace(/\/+$/, '')
  return `${url.protocol}//${url.host}${path}`
}

// Why: the URL and token are only used as a pair, so a half-set environment can
// never send the stored token to the environment's host (or the reverse).
function envAuthConfig(): BitbucketServerAuthConfig | null {
  const baseUrl = normalizeBitbucketServerBaseUrl(envValue('ORCA_BITBUCKET_SERVER_BASE_URL'))
  const accessToken = envValue('ORCA_BITBUCKET_SERVER_TOKEN')
  return baseUrl && accessToken ? { baseUrl, accessToken } : null
}

export function hasEnvBitbucketServerCredential(): boolean {
  return envAuthConfig() !== null
}

// Plaintext only, never decrypts: called on every repo detection.
export function getBitbucketServerBaseUrl(): string | null {
  const env = envAuthConfig()
  if (env) {
    return env.baseUrl
  }
  return hasStoredBitbucketServerCredential()
    ? (getStoredBitbucketServerMetadata()?.baseUrl ?? null)
    : null
}

export function hasBitbucketServerCredential(): boolean {
  return hasEnvBitbucketServerCredential() || hasStoredBitbucketServerCredential()
}

export function resolveBitbucketServerAuthConfig(): BitbucketServerAuthConfig {
  const env = envAuthConfig()
  if (env) {
    return env
  }
  try {
    const secret = loadStoredBitbucketServerSecret()
    const baseUrl = getStoredBitbucketServerMetadata()?.baseUrl ?? null
    // Why: the sealed envelope decides where the token goes; a torn or edited plaintext
    // URL that disagrees with it must not redirect the token to another host.
    return secret?.baseUrl && secret.baseUrl === baseUrl
      ? { baseUrl, accessToken: secret.accessToken }
      : { baseUrl, accessToken: null }
  } catch {
    return { baseUrl: null, accessToken: null }
  }
}

export function serverAuthHeaders(config: BitbucketServerAuthConfig): Record<string, string> {
  return config.accessToken ? { Authorization: `Bearer ${config.accessToken}` } : {}
}

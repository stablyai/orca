import {
  DEFAULT_API_BASE_URL,
  envValue,
  getEnvAuthConfig,
  hasAuth,
  type BitbucketAuthConfig
} from './bitbucket-auth-config'
import { accountNameFromUser, fetchBitbucketUserResult } from './user-request'
import {
  clearStoredBitbucketCredential,
  getStoredBitbucketMetadata,
  hasStoredBitbucketCredential,
  saveBitbucketCredential
} from './credential-store'
import type {
  BitbucketConnectArgs,
  BitbucketConnectResult,
  BitbucketConnectionStatus
} from '../../shared/bitbucket-credentials'

export type { BitbucketConnectArgs, BitbucketConnectResult, BitbucketConnectionStatus }

const VERIFY_TIMEOUT_MS = 6000

function normalize(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? ''
  return trimmed.length > 0 ? trimmed : null
}

function buildCandidateConfig(input: BitbucketConnectArgs): BitbucketAuthConfig {
  return {
    baseUrl: normalize(input.baseUrl) ?? DEFAULT_API_BASE_URL,
    accessToken: input.authMode === 'token' ? normalize(input.accessToken) : null,
    email: input.authMode === 'basic' ? normalize(input.email) : null,
    apiToken: input.authMode === 'basic' ? normalize(input.apiToken) : null
  }
}

// Verifying against `/user` before persisting keeps the stored "connected
// account" honest and lets the dialog reject a dead token inline.
export async function connectBitbucket(
  input: BitbucketConnectArgs
): Promise<BitbucketConnectResult> {
  const config = buildCandidateConfig(input)
  if (!hasAuth(config)) {
    return {
      ok: false,
      error:
        input.authMode === 'token'
          ? 'Enter an access token.'
          : 'Enter both an email and an API token.'
    }
  }
  const result = await fetchBitbucketUserResult(config, VERIFY_TIMEOUT_MS)
  if (!result.ok) {
    return {
      ok: false,
      // Why (STA-3944): telling someone their token is invalid when the network
      // is down sends them to regenerate a credential that was fine.
      error:
        result.reason === 'rejected'
          ? 'Bitbucket rejected these credentials. Check the email and token, then try again.'
          : 'Could not reach Bitbucket. Check your connection or the API base URL, then try again.'
    }
  }
  const account = accountNameFromUser(result.user)
  saveBitbucketCredential({
    authMode: input.authMode,
    email: config.email,
    baseUrl: normalize(input.baseUrl),
    account,
    accessToken: config.accessToken,
    apiToken: config.apiToken
  })
  return { ok: true, account }
}

export function disconnectBitbucket(): void {
  clearStoredBitbucketCredential()
}

// Reads env vars and plaintext metadata only — never decrypts — so the Settings
// card can call it on every open without a keychain prompt.
export function getBitbucketConnectionStatus(): BitbucketConnectionStatus {
  const env = getEnvAuthConfig()
  if (hasAuth(env)) {
    return {
      configured: true,
      source: 'environment',
      account: null,
      authMode: env.accessToken ? 'token' : 'basic',
      email: env.email,
      baseUrl: envValue('ORCA_BITBUCKET_API_BASE_URL')
    }
  }
  if (hasStoredBitbucketCredential()) {
    const metadata = getStoredBitbucketMetadata()
    return {
      configured: true,
      source: 'stored',
      account: metadata?.account ?? null,
      authMode: metadata?.authMode ?? null,
      email: metadata?.email ?? null,
      baseUrl: metadata?.baseUrl ?? null
    }
  }
  return {
    configured: false,
    source: 'none',
    account: null,
    authMode: null,
    email: null,
    baseUrl: null
  }
}

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
  getBitbucketCredentialProtection,
  hasStoredBitbucketCredential,
  saveBitbucketCredential
} from './credential-store'
import type {
  BitbucketConnectArgs,
  BitbucketConnectResult,
  BitbucketConnectionStatus
} from '../../shared/bitbucket-credentials'
import { bitbucketConnectFailure } from '../../shared/bitbucket-credentials'

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

export async function connectBitbucket(
  input: BitbucketConnectArgs
): Promise<BitbucketConnectResult> {
  const config = buildCandidateConfig(input)
  if (!hasAuth(config)) {
    return bitbucketConnectFailure(
      input.authMode === 'token' ? 'accessTokenRequired' : 'emailAndApiTokenRequired'
    )
  }
  const result = await fetchBitbucketUserResult(config, VERIFY_TIMEOUT_MS)
  if (!result.ok) {
    return bitbucketConnectFailure(result.reason === 'rejected' ? 'rejected' : 'unreachable')
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

// Status reads must avoid keychain prompts.
export function getBitbucketConnectionStatus(): BitbucketConnectionStatus {
  const env = getEnvAuthConfig()
  if (hasAuth(env)) {
    return {
      configured: true,
      source: 'environment',
      credentialProtection: null,
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
      credentialProtection: getBitbucketCredentialProtection(),
      account: metadata?.account ?? null,
      authMode: metadata?.authMode ?? null,
      email: metadata?.email ?? null,
      baseUrl: metadata?.baseUrl ?? null
    }
  }
  return {
    configured: false,
    source: 'none',
    credentialProtection: null,
    account: null,
    authMode: null,
    email: null,
    baseUrl: null
  }
}

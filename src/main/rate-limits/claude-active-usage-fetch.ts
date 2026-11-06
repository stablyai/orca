import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import {
  readClaudeOAuthCredentials,
  type ClaudeOAuthCredentialReadResult,
  resolveClaudeOAuthCredentialReadOptions
} from './claude-oauth-credentials'
import { fetchClaudeOAuthUsage } from './claude-oauth-usage-request'
import {
  claimClaudeUsageRefresh,
  claudeOAuthRefreshAccountId,
  refreshClaudeOAuthAccessToken
} from './claude-oauth-refresh'
import { classifyClaudeOAuthUsageError } from './claude-usage-error-classification'
import { OAuthUsageError } from './claude-oauth-usage-error'
import type { ClaudeRateLimitFetchOptions } from './claude-usage-fetch-options'
import { abortedClaudeRateLimitResult, makeClaudeUsageResult } from './claude-usage-result'
import { CLAUDE_PROFILE_MISSING_MESSAGE } from '../../shared/claude-profile-routing'

/** Usage observes the account. A stale access token is refreshed unless that account's Claude is running. */
export async function fetchActiveClaudeRateLimits(
  options?: ClaudeRateLimitFetchOptions
): Promise<ProviderRateLimits> {
  const usageError = options?.authPreparation?.usageError
  if (usageError) {
    return makeClaudeUsageResult('error', usageError, {
      failureKind:
        usageError === CLAUDE_PROFILE_MISSING_MESSAGE ? 'missing-credentials' : 'usage-unavailable',
      attemptedSources: []
    })
  }
  if (options?.signal?.aborted) {
    return abortedClaudeRateLimitResult()
  }
  const credentials = await readClaudeOAuthCredentials(
    resolveClaudeOAuthCredentialReadOptions(options?.authPreparation)
  )
  const metadata = {
    credentialSource: credentials.source,
    authProvenance: options?.authPreparation?.provenance ?? 'system'
  }
  // System Default without login may be an API-key/non-Claude user, not a signed-out account.
  if (
    !credentials.token &&
    !credentials.unavailable &&
    !credentials.hasRefreshableCredentials &&
    metadata.authProvenance === 'system'
  ) {
    return makeClaudeUsageResult('unavailable', 'No subscription plan — API key billing', {
      ...metadata,
      failureKind: 'missing-credentials',
      attemptedSources: []
    })
  }
  if (!credentials.token) {
    return makeClaudeUsageResult(
      'error',
      credentials.unavailable
        ? 'Claude usage is unavailable.'
        : 'Sign in again to use this account.',
      {
        ...metadata,
        failureKind: credentials.unavailable ? 'keychain-unavailable' : 'missing-credentials',
        attemptedSources: []
      }
    )
  }
  try {
    const usage = await fetchClaudeOAuthUsage(credentials.token, options?.signal)
    // Why: a successful reading names its account too, as failures and live session posts do.
    return { ...usage, usageMetadata: { ...metadata, ...usage.usageMetadata } }
  } catch (error) {
    const refreshed = await refreshStaleClaudeUsage(options, credentials, metadata, error)
    if (refreshed) {
      return refreshed
    }
    const { failureKind } = classifyClaudeOAuthUsageError(error)
    if (failureKind === 'stale-token' && !canClaudeRenewLogin(credentials, error)) {
      return makeClaudeUsageResult('error', 'Sign in again to use this account.', {
        ...metadata,
        failureKind: 'missing-credentials',
        attemptedSources: ['oauth']
      })
    }
    // Retain both the 429 polling delay and its user-visible cause.
    const retryAfterMs = error instanceof OAuthUsageError ? error.retryAfterMs : null
    return makeClaudeUsageResult(
      'error',
      failureKind === 'stale-token'
        ? // Idle login's access token lapsed, not the login; Claude refreshes it when it next runs.
          'Claude usage updates the next time Claude runs.'
        : (failureKind === 'rate-limited' || failureKind === 'missing-scope') &&
            error instanceof OAuthUsageError
          ? error.message
          : 'Claude usage is unavailable.',
      {
        ...metadata,
        failureKind,
        attemptedSources: ['oauth'],
        ...(retryAfterMs ? { retryAtMs: Date.now() + retryAfterMs } : {})
      }
    )
  }
}

async function refreshStaleClaudeUsage(
  options: ClaudeRateLimitFetchOptions | undefined,
  credentials: ClaudeOAuthCredentialReadResult,
  metadata: { credentialSource: ClaudeOAuthCredentialReadResult['source']; authProvenance: string },
  error: unknown
): Promise<ProviderRateLimits | null> {
  const { failureKind } = classifyClaudeOAuthUsageError(error)
  if (failureKind !== 'stale-token' || !canClaudeRenewLogin(credentials, error)) {
    return null
  }
  const accountId = claudeOAuthRefreshAccountId(options?.authPreparation?.provenance)
  if (!accountId || !claimClaudeUsageRefresh(accountId)) {
    return null
  }
  if (options?.signal?.aborted) {
    return abortedClaudeRateLimitResult()
  }
  const refreshed = await refreshClaudeOAuthAccessToken({
    accountId,
    readOptions: resolveClaudeOAuthCredentialReadOptions(options?.authPreparation)
  })
  if (refreshed.outcome === 'lapsed') {
    return makeClaudeUsageResult('error', 'Sign in again to use this account.', {
      ...metadata,
      failureKind: 'lapsed',
      attemptedSources: ['oauth'],
      httpStatus: 401
    })
  }
  if (refreshed.outcome !== 'refreshed') {
    return null
  }
  try {
    const usage = await fetchClaudeOAuthUsage(refreshed.accessToken, options?.signal)
    return { ...usage, usageMetadata: { ...metadata, ...usage.usageMetadata } }
  } catch (retryError) {
    return claudeUsageFailure(metadata, retryError)
  }
}

function claudeUsageFailure(
  metadata: { credentialSource: ClaudeOAuthCredentialReadResult['source']; authProvenance: string },
  error: unknown
): ProviderRateLimits {
  const { failureKind } = classifyClaudeOAuthUsageError(error)
  const httpStatus = error instanceof OAuthUsageError ? error.status : undefined
  const httpMeta = httpStatus ? { httpStatus } : {}
  if (
    failureKind === 'stale-token' &&
    error instanceof OAuthUsageError &&
    /revoked/i.test(error.message)
  ) {
    return makeClaudeUsageResult('error', 'Sign in again to use this account.', {
      ...metadata,
      failureKind: 'missing-credentials',
      attemptedSources: ['oauth'],
      ...httpMeta
    })
  }
  const retryAfterMs = error instanceof OAuthUsageError ? error.retryAfterMs : null
  return makeClaudeUsageResult(
    'error',
    failureKind === 'stale-token'
      ? 'Claude usage updates the next time Claude runs.'
      : (failureKind === 'rate-limited' || failureKind === 'missing-scope') &&
          error instanceof OAuthUsageError
        ? error.message
        : 'Claude usage is unavailable.',
    {
      ...metadata,
      failureKind,
      attemptedSources: ['oauth'],
      ...httpMeta,
      ...(retryAfterMs ? { retryAtMs: Date.now() + retryAfterMs } : {})
    }
  )
}

// Mirrors Claude Code's own refreshability check; anything else needs a new sign-in.
function canClaudeRenewLogin(
  credentials: ClaudeOAuthCredentialReadResult,
  error: unknown
): boolean {
  const refreshTokenExpiresAt = credentials.refreshTokenExpiresAt
  return (
    credentials.hasRefreshableCredentials &&
    (refreshTokenExpiresAt === undefined || refreshTokenExpiresAt > Date.now()) &&
    !(error instanceof OAuthUsageError && /revoked/i.test(error.message))
  )
}

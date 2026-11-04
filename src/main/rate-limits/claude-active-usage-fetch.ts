import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import {
  readClaudeOAuthCredentials,
  type ClaudeOAuthCredentialReadResult,
  resolveClaudeOAuthCredentialReadOptions
} from './claude-oauth-credentials'
import { fetchClaudeOAuthUsage } from './claude-oauth-usage-request'
import { classifyClaudeOAuthUsageError } from './claude-usage-error-classification'
import { OAuthUsageError } from './claude-oauth-usage-error'
import type { ClaudeRateLimitFetchOptions } from './claude-usage-fetch-options'
import { abortedClaudeRateLimitResult, makeClaudeUsageResult } from './claude-usage-result'
import { CLAUDE_PROFILE_MISSING_MESSAGE } from '../../shared/claude-profile-routing'

/** Usage observes the account; only a user-started Claude process may refresh its login. */
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
    return await fetchClaudeOAuthUsage(credentials.token, options?.signal)
  } catch (error) {
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

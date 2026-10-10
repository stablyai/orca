import { homedir } from 'node:os'
import { join } from 'node:path'
import { fetchCachedClaudeUsage } from './claude-usage-cache'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import {
  readClaudeOAuthCredentials,
  resolveClaudeOAuthCredentialReadOptions
} from './claude-oauth-credentials'
import { fetchClaudeOAuthUsage } from './claude-oauth-usage-request'
import { classifyClaudeOAuthUsageError } from './claude-usage-error-classification'
import { OAuthUsageError } from './claude-oauth-usage-error'
import type { ClaudeRateLimitFetchOptions } from './claude-usage-fetch-options'
import { abortedClaudeRateLimitResult, makeClaudeUsageResult } from './claude-usage-result'
import { CLAUDE_PROFILE_MISSING_MESSAGE } from '../../shared/claude-profile-routing'

/**
 * 모든 조회 경로에서 계정의 서버 대기를 지키며 사용량만 관찰한다.
 * @param options 계정 인증 경로와 취소 신호
 * @returns 캐시된 사용량 또는 새 조회 결과
 */
export async function fetchActiveClaudeRateLimits(
  options?: ClaudeRateLimitFetchOptions
): Promise<ProviderRateLimits> {
  if (options?.signal?.aborted) {
    return abortedClaudeRateLimitResult()
  }
  if (options?.authPreparation?.usageError) {
    return fetchUncachedClaudeRateLimits(options)
  }
  const configDir = options?.authPreparation?.configDir ?? join(homedir(), '.claude')
  return fetchCachedClaudeUsage(configDir, () => fetchUncachedClaudeRateLimits(options))
}

/**
 * 대기 확인 후 인증을 읽고 한 번 조회한다.
 * @param options 계정 인증 경로와 취소 신호
 * @returns 해당 계정의 사용량 또는 오류
 */
async function fetchUncachedClaudeRateLimits(
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
  // Why: System Default with no Claude login is an API-key or non-Claude user, not a signed-out account.
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
    // Why: the 429 wait gates the poll, and both messages tell the user why usage is missing.
    const retryAfterMs = error instanceof OAuthUsageError ? error.retryAfterMs : null
    return makeClaudeUsageResult(
      'error',
      failureKind === 'stale-token'
        ? // Why: Claude refreshes its own login when it next runs; System Default has no "account".
          metadata.authProvenance === 'system'
          ? 'Claude usage updates the next time Claude runs.'
          : 'Claude usage has expired. Start Claude in this account to refresh it.'
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

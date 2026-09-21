import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import type { ClaudeRuntimeAuthPreparation } from '../claude-accounts/runtime-auth-service'
import { withMacTailscaleDnsHint } from '../network/macos-tailscale-dns-diagnostic'
import { completeClaudeOAuthUsageSuccess, fetchClaudeUsageViaCli } from './claude-cli-usage-fetch'
import {
  readClaudeCredentialsFromStrictKeychain,
  readClaudeOAuthCredentials,
  resolveClaudeOAuthCredentialReadOptions,
  type ClaudeOAuthCredentialReadResult
} from './claude-oauth-credentials'
import { OAuthUsageError } from './claude-oauth-usage-error'
import { fetchClaudeOAuthUsage } from './claude-oauth-usage-request'
import type { ClaudeUsageErrorClassification } from './claude-usage-error-classification'
import type { ClaudeRateLimitFetchOptions } from './claude-usage-fetch-options'
import {
  abortedClaudeRateLimitResult,
  isManagedClaudeAuth,
  makeClaudeUsageResult,
  mergeClaudeUsageWindows,
  metadataForClaudeUsageAttempt,
  recordClaudeUsageAttempt,
  type ClaudeUsageAttemptState,
  warnClaudeUsageFetchFailure,
  withClaudeUsageMetadata
} from './claude-usage-result'

const LIVE_REFRESH_DEFERRED_MESSAGE =
  'Claude usage refresh is waiting for the live Claude terminal to rotate its credentials.'

export function canRetryClaudeOAuthWithLegacyKeychain(input: {
  classification: ClaudeUsageErrorClassification
  oauthCredentials: ClaudeOAuthCredentialReadResult
  authPreparation?: ClaudeRuntimeAuthPreparation
}): boolean {
  return (
    input.classification.failureKind === 'stale-token' &&
    input.oauthCredentials.source === 'scoped-keychain' &&
    (input.authPreparation?.runtime ?? 'host') === 'host' &&
    !isManagedClaudeAuth(input.authPreparation)
  )
}

export async function retryClaudeOAuthWithLegacyKeychain(input: {
  failedToken: string | null
  attempts: ClaudeUsageAttemptState
  options?: ClaudeRateLimitFetchOptions
}): Promise<ProviderRateLimits | null> {
  const legacy = await readClaudeCredentialsFromStrictKeychain(undefined, 'legacy-keychain')
  if (!legacy.token || legacy.token === input.failedToken) {
    return null
  }
  if (input.options?.signal?.aborted) {
    return abortedClaudeRateLimitResult()
  }
  try {
    const limits = await fetchClaudeOAuthUsage(legacy.token, input.options?.signal)
    if (input.options?.signal?.aborted) {
      return abortedClaudeRateLimitResult()
    }
    return await completeClaudeOAuthUsageSuccess({
      oauthLimits: limits,
      oauthCredentials: legacy,
      attempts: input.attempts,
      options: input.options
    })
  } catch (error) {
    warnClaudeUsageFetchFailure(input.options?.authPreparation, legacy, error)
    return null
  }
}

export function shouldDeferClaudeUsageForLiveSession(
  authPreparation: ClaudeRuntimeAuthPreparation | undefined,
  classification: ClaudeUsageErrorClassification
): boolean {
  return Boolean(
    authPreparation?.managedRefreshDeferredByLivePty &&
    (classification.failureKind === 'stale-token' ||
      classification.failureKind === 'refreshable-credentials-without-token' ||
      classification.failureKind === 'deferred-by-live-session')
  )
}

export function makeLiveClaudeUsageDeferredResult(input: {
  attempts: ClaudeUsageAttemptState
  oauthCredentials: ClaudeOAuthCredentialReadResult
  authPreparation?: ClaudeRuntimeAuthPreparation
}): ProviderRateLimits {
  return makeClaudeUsageResult('error', LIVE_REFRESH_DEFERRED_MESSAGE, {
    ...metadataForClaudeUsageAttempt({
      attemptedSources: input.attempts.attemptedSources,
      oauthCredentials: input.oauthCredentials,
      authPreparation: input.authPreparation,
      failureKind: 'deferred-by-live-session',
      deferredByLiveClaudeSession: true
    })
  })
}

export function makeClaudeUsageClassificationError(input: {
  error: unknown
  classification: ClaudeUsageErrorClassification
  attempts: ClaudeUsageAttemptState
  oauthCredentials: ClaudeOAuthCredentialReadResult
  authPreparation?: ClaudeRuntimeAuthPreparation
}): ProviderRateLimits {
  const message =
    input.error instanceof Error ? input.error.message : String(input.error || 'Unknown error')
  const retryAfterMs = input.error instanceof OAuthUsageError ? input.error.retryAfterMs : null
  return makeClaudeUsageResult('error', withMacTailscaleDnsHint(message), {
    ...metadataForClaudeUsageAttempt({
      attemptedSources: input.attempts.attemptedSources,
      oauthCredentials: input.oauthCredentials,
      authPreparation: input.authPreparation,
      failureKind: input.classification.failureKind,
      retryAtMs: retryAfterMs ? Date.now() + retryAfterMs : undefined
    })
  })
}

export async function repairClaudeCredentialsThenRetryOAuth(input: {
  options?: ClaudeRateLimitFetchOptions
  attempts: ClaudeUsageAttemptState
  oauthCredentials: ClaudeOAuthCredentialReadResult
}): Promise<ProviderRateLimits | null> {
  if (input.options?.signal?.aborted) {
    return abortedClaudeRateLimitResult()
  }
  let cliResult: ProviderRateLimits | null = null
  try {
    cliResult = await fetchClaudeUsageViaCli({
      authPreparation: input.options?.authPreparation,
      oauthCredentials: input.oauthCredentials,
      attempts: input.attempts,
      networkProxySettings: input.options?.networkProxySettings,
      signal: input.options?.signal
    })
  } catch (error) {
    warnClaudeUsageFetchFailure(input.options?.authPreparation, input.oauthCredentials, error)
  }

  if (input.options?.signal?.aborted) {
    return abortedClaudeRateLimitResult()
  }
  const refreshed = await readClaudeOAuthCredentials(
    resolveClaudeOAuthCredentialReadOptions(input.options?.authPreparation)
  )
  if (input.options?.signal?.aborted) {
    return abortedClaudeRateLimitResult()
  }
  if (refreshed.token) {
    recordClaudeUsageAttempt(input.attempts, 'oauth')
    try {
      const retry = await fetchClaudeOAuthUsage(refreshed.token, input.options?.signal)
      if (input.options?.signal?.aborted) {
        return abortedClaudeRateLimitResult()
      }
      return withClaudeUsageMetadata(
        mergeClaudeUsageWindows(retry, cliResult),
        metadataForClaudeUsageAttempt({
          attemptedSources: input.attempts.attemptedSources,
          oauthCredentials: refreshed,
          authPreparation: input.options?.authPreparation,
          source: 'oauth'
        })
      )
    } catch (error) {
      warnClaudeUsageFetchFailure(input.options?.authPreparation, refreshed, error)
    }
  }
  return cliResult
}

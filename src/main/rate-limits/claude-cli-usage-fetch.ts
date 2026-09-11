import type { ProviderRateLimits, UsageRateLimitFailureKind } from '../../shared/rate-limit-types'
import type { NetworkProxySettings } from '../../shared/network-proxy'
import type { ClaudeRuntimeAuthPreparation } from '../claude-accounts/runtime-auth-service'
import { fetchViaPty } from './claude-pty'
import type { ClaudeOAuthCredentialReadResult } from './claude-oauth-credentials'
import type { ClaudeRateLimitFetchOptions } from './claude-usage-fetch-options'
import {
  abortedClaudeRateLimitResult,
  canSupplementClaudeOAuthUsage,
  isManagedClaudeAuth,
  mergeClaudeUsageWindows,
  metadataForClaudeUsageAttempt,
  recordClaudeUsageAttempt,
  type ClaudeUsageAttemptState,
  warnClaudeUsageFetchFailure,
  withClaudeUsageMetadata
} from './claude-usage-result'

function classifyClaudeCliUsageFailure(
  limits: ProviderRateLimits
): UsageRateLimitFailureKind | undefined {
  if (!limits.error) {
    return undefined
  }
  if (/rate limited/i.test(limits.error)) {
    return 'rate-limited'
  }
  if (/plan usage is unavailable|usage is unavailable/i.test(limits.error)) {
    return 'usage-unavailable'
  }
  return 'cli-unavailable'
}

export async function fetchClaudeUsageViaCli(input: {
  authPreparation?: ClaudeRuntimeAuthPreparation
  oauthCredentials: ClaudeOAuthCredentialReadResult
  attempts: ClaudeUsageAttemptState
  networkProxySettings?: NetworkProxySettings
  signal?: AbortSignal
}): Promise<ProviderRateLimits> {
  recordClaudeUsageAttempt(input.attempts, 'cli')
  const limits = await fetchViaPty({
    authPreparation: input.authPreparation,
    networkProxySettings: input.networkProxySettings,
    signal: input.signal
  })
  return withClaudeUsageMetadata(
    limits,
    metadataForClaudeUsageAttempt({
      attemptedSources: input.attempts.attemptedSources,
      oauthCredentials: input.oauthCredentials,
      authPreparation: input.authPreparation,
      source: 'cli',
      failureKind: classifyClaudeCliUsageFailure(limits)
    })
  )
}

async function supplementOAuthUsageFromCli(input: {
  oauthLimits: ProviderRateLimits
  authPreparation?: ClaudeRuntimeAuthPreparation
  oauthCredentials: ClaudeOAuthCredentialReadResult
  attempts: ClaudeUsageAttemptState
  allowUsagePanelSupplement: boolean
  networkProxySettings?: NetworkProxySettings
  signal?: AbortSignal
}): Promise<ProviderRateLimits> {
  if (input.signal?.aborted || !canSupplementClaudeOAuthUsage(input)) {
    return input.oauthLimits
  }
  try {
    return mergeClaudeUsageWindows(
      input.oauthLimits,
      await fetchClaudeUsageViaCli({
        authPreparation: input.authPreparation,
        oauthCredentials: input.oauthCredentials,
        attempts: input.attempts,
        networkProxySettings: input.networkProxySettings,
        signal: input.signal
      })
    )
  } catch (error) {
    warnClaudeUsageFetchFailure(input.authPreparation, input.oauthCredentials, error)
    return input.oauthLimits
  }
}

export async function completeClaudeOAuthUsageSuccess(input: {
  oauthLimits: ProviderRateLimits
  oauthCredentials: ClaudeOAuthCredentialReadResult
  attempts: ClaudeUsageAttemptState
  options?: ClaudeRateLimitFetchOptions
}): Promise<ProviderRateLimits> {
  const limits = await supplementOAuthUsageFromCli({
    oauthLimits: input.oauthLimits,
    authPreparation: input.options?.authPreparation,
    oauthCredentials: input.oauthCredentials,
    attempts: input.attempts,
    networkProxySettings: input.options?.networkProxySettings,
    allowUsagePanelSupplement:
      input.options?.allowUsagePanelSupplement ??
      isManagedClaudeAuth(input.options?.authPreparation),
    signal: input.options?.signal
  })
  if (input.options?.signal?.aborted) {
    return abortedClaudeRateLimitResult()
  }
  return withClaudeUsageMetadata(
    limits,
    metadataForClaudeUsageAttempt({
      attemptedSources: input.attempts.attemptedSources,
      oauthCredentials: input.oauthCredentials,
      authPreparation: input.options?.authPreparation,
      source: 'oauth'
    })
  )
}

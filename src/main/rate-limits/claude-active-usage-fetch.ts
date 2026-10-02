import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import {
  readClaudeOAuthCredentials,
  resolveClaudeOAuthCredentialReadOptions
} from './claude-oauth-credentials'
import {
  canRetryClaudeOAuthWithLegacyKeychain,
  failureKindAfterClaudeLoginRepair,
  makeClaudeUsageClassificationError,
  makeLiveClaudeUsageDeferredResult,
  repairClaudeCredentialsThenRetryOAuth,
  retryClaudeOAuthWithLegacyKeychain,
  shouldDeferClaudeUsageForLiveSession
} from './claude-oauth-recovery'
import { fetchClaudeOAuthUsage } from './claude-oauth-usage-request'
import {
  classifyClaudeCredentialAbsence,
  classifyClaudeOAuthUsageError
} from './claude-usage-error-classification'
import type { ClaudeRateLimitFetchOptions } from './claude-usage-fetch-options'
import {
  abortedClaudeRateLimitResult,
  claudeOAuthUsageSuccess,
  isManagedClaudeAuth,
  makeClaudeUsageResult,
  metadataForClaudeUsageAttempt,
  recordClaudeUsageAttempt,
  warnClaudeUsageFetchFailure
} from './claude-usage-result'

export async function fetchActiveClaudeRateLimits(
  options?: ClaudeRateLimitFetchOptions
): Promise<ProviderRateLimits> {
  if (options?.signal?.aborted) {
    return abortedClaudeRateLimitResult()
  }
  const attempts = { attemptedSources: [] }

  if (options?.authPreparation?.runtime === 'wsl' && !options.authPreparation.wslLinuxConfigDir) {
    return makeClaudeUsageResult(
      'error',
      `WSL Claude config unavailable for ${options.authPreparation.wslDistro ?? 'default distro'}`,
      {
        attemptedSources: [],
        failureKind: 'cli-unavailable',
        authProvenance: options.authPreparation.provenance
      }
    )
  }

  const oauthCredentials = await readClaudeOAuthCredentials(
    resolveClaudeOAuthCredentialReadOptions(options?.authPreparation)
  )
  if (options?.signal?.aborted) {
    return abortedClaudeRateLimitResult()
  }

  if (oauthCredentials.token) {
    recordClaudeUsageAttempt(attempts, 'oauth')
    try {
      const limits = await fetchClaudeOAuthUsage(oauthCredentials.token, options?.signal)
      if (options?.signal?.aborted) {
        return abortedClaudeRateLimitResult()
      }
      return claudeOAuthUsageSuccess({
        limits,
        oauthCredentials,
        attempts,
        authPreparation: options?.authPreparation
      })
    } catch (error) {
      warnClaudeUsageFetchFailure(options?.authPreparation, oauthCredentials, error)
      const classification = classifyClaudeOAuthUsageError(error)

      if (
        canRetryClaudeOAuthWithLegacyKeychain({
          classification,
          oauthCredentials,
          authPreparation: options?.authPreparation
        })
      ) {
        const legacyResult = await retryClaudeOAuthWithLegacyKeychain({
          failedToken: oauthCredentials.token,
          attempts,
          options
        })
        if (legacyResult) {
          return legacyResult
        }
      }

      if (shouldDeferClaudeUsageForLiveSession(options?.authPreparation, classification)) {
        return makeLiveClaudeUsageDeferredResult({
          attempts,
          oauthCredentials,
          authPreparation: options?.authPreparation
        })
      }

      let failureKind = classification.failureKind
      if (classification.shouldAttemptDelegatedRefresh) {
        const repair = await repairClaudeCredentialsThenRetryOAuth({
          options,
          attempts,
          oauthCredentials
        })
        if (repair.kind === 'result') {
          return repair.result
        }
        failureKind = failureKindAfterClaudeLoginRepair(repair, failureKind)
      }

      return makeClaudeUsageClassificationError({
        error,
        classification: { ...classification, failureKind },
        attempts,
        oauthCredentials,
        authPreparation: options?.authPreparation
      })
    }
  }

  const credentialClassification = classifyClaudeCredentialAbsence({
    hasRefreshableCredentials: oauthCredentials.hasRefreshableCredentials,
    keychainUnavailable: oauthCredentials.keychainUnavailable,
    managedRefreshDeferredByLivePty: options?.authPreparation?.managedRefreshDeferredByLivePty
  })

  if (shouldDeferClaudeUsageForLiveSession(options?.authPreparation, credentialClassification)) {
    return makeLiveClaudeUsageDeferredResult({
      attempts,
      oauthCredentials,
      authPreparation: options?.authPreparation
    })
  }

  let absenceFailureKind = credentialClassification.failureKind
  if (
    oauthCredentials.hasRefreshableCredentials &&
    credentialClassification.shouldAttemptDelegatedRefresh
  ) {
    const repair = await repairClaudeCredentialsThenRetryOAuth({
      options,
      attempts,
      oauthCredentials
    })
    if (repair.kind === 'result') {
      return repair.result
    }
    absenceFailureKind = failureKindAfterClaudeLoginRepair(repair, absenceFailureKind)
  }

  if (oauthCredentials.keychainUnavailable) {
    return makeClaudeUsageResult('error', 'Claude Keychain credentials unavailable', {
      ...metadataForClaudeUsageAttempt({
        attemptedSources: attempts.attemptedSources,
        oauthCredentials,
        authPreparation: options?.authPreparation,
        failureKind: 'keychain-unavailable'
      })
    })
  }

  if (oauthCredentials.hasRefreshableCredentials) {
    return makeClaudeUsageResult('error', 'Claude OAuth access token unavailable', {
      ...metadataForClaudeUsageAttempt({
        attemptedSources: attempts.attemptedSources,
        oauthCredentials,
        authPreparation: options?.authPreparation,
        failureKind: absenceFailureKind
      })
    })
  }

  const metadata = metadataForClaudeUsageAttempt({
    attemptedSources: attempts.attemptedSources,
    oauthCredentials,
    authPreparation: options?.authPreparation,
    failureKind: 'missing-credentials'
  })
  // A managed account with no login is signed out; without one, the user may bill by API key.
  return isManagedClaudeAuth(options?.authPreparation)
    ? makeClaudeUsageResult('error', 'Claude account is signed out', metadata)
    : makeClaudeUsageResult('unavailable', 'No subscription plan — API key billing', metadata)
}

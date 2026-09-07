import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import { withMacTailscaleDnsHint } from '../network/macos-tailscale-dns-diagnostic'
import { completeClaudeOAuthUsageSuccess, fetchClaudeUsageViaCli } from './claude-cli-usage-fetch'
import {
  readClaudeOAuthCredentials,
  resolveClaudeOAuthCredentialReadOptions
} from './claude-oauth-credentials'
import {
  canRetryClaudeOAuthWithLegacyKeychain,
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
import { resolveClaudeUsageRefreshPlan } from './claude-usage-refresh-plan'
import {
  abortedClaudeRateLimitResult,
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
  const allowCliFallback = options?.allowPtyFallback !== false
  const plan = resolveClaudeUsageRefreshPlan({
    authPreparation: options?.authPreparation,
    allowCliFallback
  })

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

  if (plan.steps.some((step) => step.source === 'oauth') && oauthCredentials.token) {
    recordClaudeUsageAttempt(attempts, 'oauth')
    try {
      const oauthLimits = await fetchClaudeOAuthUsage(oauthCredentials.token, options?.signal)
      if (options?.signal?.aborted) {
        return abortedClaudeRateLimitResult()
      }
      return await completeClaudeOAuthUsageSuccess({
        oauthLimits,
        oauthCredentials,
        attempts,
        options
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

      if (classification.shouldAttemptDelegatedRefresh && allowCliFallback) {
        const repaired = await repairClaudeCredentialsThenRetryOAuth({
          options,
          attempts,
          oauthCredentials
        })
        if (repaired) {
          return repaired
        }
      }

      if (classification.shouldAttemptCliFallback && allowCliFallback) {
        try {
          return await fetchClaudeUsageViaCli({
            authPreparation: options?.authPreparation,
            oauthCredentials,
            attempts,
            networkProxySettings: options?.networkProxySettings,
            signal: options?.signal
          })
        } catch (ptyError) {
          warnClaudeUsageFetchFailure(options?.authPreparation, oauthCredentials, ptyError)
        }
      }

      return makeClaudeUsageClassificationError({
        error,
        classification,
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

  if (
    oauthCredentials.hasRefreshableCredentials &&
    credentialClassification.shouldAttemptDelegatedRefresh &&
    allowCliFallback
  ) {
    const repaired = await repairClaudeCredentialsThenRetryOAuth({
      options,
      attempts,
      oauthCredentials
    })
    if (repaired) {
      return repaired
    }
  }

  if (
    (oauthCredentials.token ||
      oauthCredentials.hasRefreshableCredentials ||
      oauthCredentials.keychainUnavailable) &&
    credentialClassification.shouldAttemptCliFallback &&
    allowCliFallback
  ) {
    try {
      return await fetchClaudeUsageViaCli({
        authPreparation: options?.authPreparation,
        oauthCredentials,
        attempts,
        networkProxySettings: options?.networkProxySettings,
        signal: options?.signal
      })
    } catch (error) {
      warnClaudeUsageFetchFailure(options?.authPreparation, oauthCredentials, error)
      return makeClaudeUsageResult(
        'error',
        withMacTailscaleDnsHint(error instanceof Error ? error.message : 'Unknown error'),
        {
          ...metadataForClaudeUsageAttempt({
            attemptedSources: attempts.attemptedSources,
            oauthCredentials,
            authPreparation: options?.authPreparation,
            failureKind:
              credentialClassification.failureKind === 'keychain-unavailable'
                ? 'keychain-unavailable'
                : 'cli-unavailable'
          })
        }
      )
    }
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
        failureKind: credentialClassification.failureKind
      })
    })
  }

  if (allowCliFallback && plan.steps.some((step) => step.source === 'cli')) {
    try {
      return await fetchClaudeUsageViaCli({
        authPreparation: options?.authPreparation,
        oauthCredentials,
        attempts,
        networkProxySettings: options?.networkProxySettings,
        signal: options?.signal
      })
    } catch (error) {
      warnClaudeUsageFetchFailure(options?.authPreparation, oauthCredentials, error)
    }
  }

  return makeClaudeUsageResult('unavailable', 'No subscription plan — API key billing', {
    ...metadataForClaudeUsageAttempt({
      attemptedSources: attempts.attemptedSources,
      oauthCredentials,
      authPreparation: options?.authPreparation,
      failureKind: 'missing-credentials'
    })
  })
}

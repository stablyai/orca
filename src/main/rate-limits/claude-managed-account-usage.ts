import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import {
  isOauthTokenExpiring,
  refreshClaudeOauthCredentials
} from '../claude-accounts/oauth-refresh'
import {
  readClaudeManagedCredentialsJson,
  resolveClaudeManagedCredentialsLocation,
  writeClaudeManagedCredentialsJson,
  type InactiveClaudeAccount
} from './claude-managed-account-credentials'
import { fetchClaudeManagedUsagePanelSupplement } from './claude-managed-usage-panel'
import { parseClaudeOAuthCredentialsJson } from './claude-oauth-credentials'
import { makeClaudeUsageClassificationError } from './claude-oauth-recovery'
import { fetchClaudeOAuthUsage } from './claude-oauth-usage-request'
import { classifyClaudeOAuthUsageError } from './claude-usage-error-classification'
import type { ClaudeManagedAccountUsageOptions } from './claude-usage-fetch-options'
import {
  abortedClaudeRateLimitResult,
  canSupplementClaudeOAuthUsage,
  mergeClaudeUsageWindows,
  warnClaudeUsageFetchFailure
} from './claude-usage-result'

function noClaudeManagedCredentialsResult(): ProviderRateLimits {
  return {
    provider: 'claude',
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error: 'No credentials',
    status: 'error'
  }
}

export async function fetchInactiveClaudeAccountUsage(
  account: InactiveClaudeAccount,
  options: ClaudeManagedAccountUsageOptions = {}
): Promise<ProviderRateLimits> {
  if (options.signal?.aborted) {
    return abortedClaudeRateLimitResult()
  }
  const location = resolveClaudeManagedCredentialsLocation(account)
  let credentialsJson = location ? await readClaudeManagedCredentialsJson(location) : null
  if (options.signal?.aborted) {
    return abortedClaudeRateLimitResult()
  }
  if (!location || !credentialsJson) {
    return noClaudeManagedCredentialsResult()
  }

  const credentialSource = location.kind === 'keychain' ? 'scoped-keychain' : 'credentials-file'
  let token = parseClaudeOAuthCredentialsJson(credentialsJson, credentialSource).token
  if (isOauthTokenExpiring(credentialsJson)) {
    const refreshed = await refreshClaudeOauthCredentials(credentialsJson)
    if (options.signal?.aborted) {
      return abortedClaudeRateLimitResult()
    }
    if (refreshed) {
      try {
        await writeClaudeManagedCredentialsJson(location, refreshed)
      } catch {
        // Keep the refreshed token for this fetch; a later poll can persist it.
      }
      credentialsJson = refreshed
      token = parseClaudeOAuthCredentialsJson(refreshed, credentialSource).token
    }
  }

  if (!token) {
    return noClaudeManagedCredentialsResult()
  }
  let oauthLimits: ProviderRateLimits
  try {
    oauthLimits = await fetchClaudeOAuthUsage(token, options.signal)
  } catch (error) {
    if (options.signal?.aborted) {
      return abortedClaudeRateLimitResult()
    }
    const classification = classifyClaudeOAuthUsageError(error)
    if (classification.failureKind !== 'rate-limited') {
      throw error
    }
    const failure = makeClaudeUsageClassificationError({
      error,
      classification,
      attempts: { attemptedSources: ['oauth'] },
      oauthCredentials: parseClaudeOAuthCredentialsJson(credentialsJson, credentialSource)
    })
    return {
      ...failure,
      usageMetadata: {
        ...failure.usageMetadata,
        authProvenance:
          account.managedAuthRuntime === 'wsl'
            ? `managed:${account.id}:wsl:${account.wslDistro ?? ''}`
            : `managed:${account.id}`
      }
    }
  }
  if (options.signal?.aborted) {
    return abortedClaudeRateLimitResult()
  }
  if (
    !canSupplementClaudeOAuthUsage({
      oauthLimits,
      authPreparation: undefined,
      allowUsagePanelSupplement: options.allowUsagePanelSupplement === true
    })
  ) {
    return oauthLimits
  }

  try {
    return mergeClaudeUsageWindows(
      oauthLimits,
      await fetchClaudeManagedUsagePanelSupplement({
        account,
        location,
        credentialsJson,
        oauthLimits,
        networkProxySettings: options.networkProxySettings,
        signal: options.signal
      })
    )
  } catch (error) {
    warnClaudeUsageFetchFailure(
      undefined,
      parseClaudeOAuthCredentialsJson(credentialsJson, credentialSource),
      error
    )
    return oauthLimits
  }
}

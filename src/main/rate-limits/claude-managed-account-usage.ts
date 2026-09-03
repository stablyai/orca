import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import {
  readClaudeManagedCredentialsObserved,
  resolveClaudeManagedCredentialsLocation,
  type InactiveClaudeAccount
} from './claude-managed-account-credentials'
import { fetchClaudeManagedUsagePanelSupplement } from './claude-managed-usage-panel'
import { parseClaudeOAuthCredentialsJson } from './claude-oauth-credentials'
import { fetchClaudeOAuthUsage } from './claude-oauth-usage-request'
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
  const readResult = location ? await readClaudeManagedCredentialsObserved(location) : null
  const credentialsJson = readResult?.kind === 'present' ? readResult.credentialsJson : null
  if (options.signal?.aborted) {
    return abortedClaudeRateLimitResult()
  }
  if (!location || !credentialsJson) {
    if (readResult?.kind === 'unavailable') {
      return { ...noClaudeManagedCredentialsResult(), error: 'Credentials unavailable' }
    }
    return noClaudeManagedCredentialsResult()
  }

  const token = parseClaudeOAuthCredentialsJson(credentialsJson, 'credentials-file').token

  if (!token) {
    return noClaudeManagedCredentialsResult()
  }
  const oauthLimits = await fetchClaudeOAuthUsage(token, options.signal)
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
      parseClaudeOAuthCredentialsJson(credentialsJson, 'credentials-file'),
      error
    )
    return oauthLimits
  }
}

import type { ProviderRateLimits, UsageRateLimitFailureKind } from '../../shared/rate-limit-types'
import {
  isOauthTokenExpired,
  isOauthTokenExpiring,
  refreshClaudeOauthCredentialsWithOutcome,
  type ClaudeOauthRefreshFailure
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
  makeClaudeUsageResult,
  mergeClaudeUsageWindows,
  warnClaudeUsageFetchFailure
} from './claude-usage-result'

function managedAuthProvenance(account: InactiveClaudeAccount): string {
  return account.managedAuthRuntime === 'wsl'
    ? `managed:${account.id}:wsl:${account.wslDistro ?? ''}`
    : `managed:${account.id}`
}

function noClaudeManagedCredentialsResult(account: InactiveClaudeAccount): ProviderRateLimits {
  return makeClaudeUsageResult('error', 'No credentials', {
    attemptedSources: [],
    failureKind: 'missing-credentials',
    authProvenance: managedAuthProvenance(account)
  })
}

const REFRESH_FAILURE_KINDS: Record<
  Exclude<ClaudeOauthRefreshFailure, 'invalid-grant'>,
  UsageRateLimitFailureKind
> = {
  'no-refresh-token': 'refreshable-credentials-without-token',
  'rate-limited': 'rate-limited',
  rejected: 'server',
  network: 'network',
  'unsupported-proxy': 'network'
}

function refreshFailedResult(
  account: InactiveClaudeAccount,
  failure: Exclude<ClaudeOauthRefreshFailure, 'invalid-grant'>
): ProviderRateLimits {
  return makeClaudeUsageResult('error', `Token refresh failed (${failure})`, {
    source: 'oauth',
    attemptedSources: ['oauth'],
    failureKind: REFRESH_FAILURE_KINDS[failure],
    credentialSource: 'credentials-file',
    authProvenance: managedAuthProvenance(account)
  })
}

// Why: a dead refresh token is not transient; the row must say "sign in again" instead of retrying into 401s.
function reauthRequiredResult(account: InactiveClaudeAccount): ProviderRateLimits {
  return makeClaudeUsageResult('error', 'Sign in to this account again', {
    source: 'oauth',
    attemptedSources: ['oauth'],
    failureKind: 'reauth-required',
    credentialSource: 'credentials-file',
    authProvenance: managedAuthProvenance(account)
  })
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
    return noClaudeManagedCredentialsResult(account)
  }

  let oauthCredentials = parseClaudeOAuthCredentialsJson(credentialsJson, 'credentials-file')
  if (isOauthTokenExpiring(credentialsJson)) {
    const refresh = await refreshClaudeOauthCredentialsWithOutcome(credentialsJson, {
      networkProxySettings: options.networkProxySettings,
      signal: options.signal
    })
    if (options.signal?.aborted) {
      return abortedClaudeRateLimitResult()
    }
    if (refresh.credentialsJson) {
      try {
        await writeClaudeManagedCredentialsJson(location, refresh.credentialsJson)
      } catch {
        // Keep the refreshed token for this fetch; a later poll can persist it.
      }
      credentialsJson = refresh.credentialsJson
      oauthCredentials = parseClaudeOAuthCredentialsJson(credentialsJson, 'credentials-file')
    } else if (refresh.failure === 'invalid-grant') {
      return reauthRequiredResult(account)
    } else if (refresh.failure && isOauthTokenExpired(credentialsJson)) {
      // Why: an already-expired token can only turn into a 401; report the refresh failure and let the next open retry.
      return refreshFailedResult(account, refresh.failure)
    }
    // Why: inside the refresh buffer the stored token is still accepted; a transient refresh failure just means we use it once more.
  }

  const token = oauthCredentials.token
  if (!token) {
    return noClaudeManagedCredentialsResult(account)
  }
  let oauthLimits: ProviderRateLimits
  try {
    oauthLimits = await fetchClaudeOAuthUsage(token, options.signal)
  } catch (error) {
    if (options.signal?.aborted) {
      return abortedClaudeRateLimitResult()
    }
    warnClaudeUsageFetchFailure(undefined, oauthCredentials, error)
    // Why: same classification as the active account, so the switcher can tell a 429 from a dead login.
    return makeClaudeUsageClassificationError({
      error,
      classification: classifyClaudeOAuthUsageError(error),
      attempts: { attemptedSources: ['oauth'] },
      oauthCredentials
    })
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
    warnClaudeUsageFetchFailure(undefined, oauthCredentials, error)
    return oauthLimits
  }
}

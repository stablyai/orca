import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import {
  isOauthTokenExpiring,
  refreshClaudeOauthCredentials
} from '../claude-accounts/oauth-refresh'
import {
  isClaudeAccountHeldByPinnedLaunch,
  readClaudeManagedCredentialsJson,
  readStagedClaudeManagedPreviewCredentials,
  resolveClaudeManagedCredentialsLocation,
  writeClaudeManagedCredentialsJson,
  type ClaudeManagedCredentialsLocation,
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
  // Why: a `--account` Claude may be refreshing this account right now; a second refresh from
  // here would replay its single-use refresh token and revoke the session.
  const heldByPinnedLaunch = isClaudeAccountHeldByPinnedLaunch(account.id)
  let credentialsJson = location
    ? heldByPinnedLaunch
      ? await readPinnedLaunchCredentialsJson(location)
      : await readClaudeManagedCredentialsJson(location)
    : null
  if (options.signal?.aborted) {
    return abortedClaudeRateLimitResult()
  }
  if (!location || !credentialsJson) {
    return noClaudeManagedCredentialsResult()
  }

  let token = parseClaudeOAuthCredentialsJson(credentialsJson, 'credentials-file').token
  if (!heldByPinnedLaunch && isOauthTokenExpiring(credentialsJson)) {
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
      token = parseClaudeOAuthCredentialsJson(refreshed, 'credentials-file').token
    }
  }

  if (!token) {
    return noClaudeManagedCredentialsResult()
  }
  const oauthLimits = await fetchClaudeOAuthUsage(token, options.signal)
  if (options.signal?.aborted) {
    return abortedClaudeRateLimitResult()
  }
  if (
    heldByPinnedLaunch ||
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

/** Read-only: the pinned session's own Keychain copy is the fresher store on macOS. */
async function readPinnedLaunchCredentialsJson(
  location: ClaudeManagedCredentialsLocation
): Promise<string | null> {
  return (
    (await readStagedClaudeManagedPreviewCredentials(location)) ??
    (await readClaudeManagedCredentialsJson(location))
  )
}

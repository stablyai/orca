import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import {
  storedOauthCredentialDiffers,
  withClaudeManagedCredentialRotation
} from '../claude-accounts/managed-credential-rotation'
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
import { OAuthUsageError } from './claude-oauth-usage-error'
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

function noClaudeManagedCredentialsResult(): ProviderRateLimits {
  return makeClaudeUsageResult('error', 'No credentials', {
    attemptedSources: ['oauth'],
    failureKind: 'missing-credentials'
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
    return noClaudeManagedCredentialsResult()
  }

  let token = parseClaudeOAuthCredentialsJson(credentialsJson, 'credentials-file').token
  let refreshedThisCall = false
  if (isOauthTokenExpiring(credentialsJson)) {
    refreshedThisCall = true
    const refreshed = await persistRefreshedInactiveCredentials(
      account.id,
      location,
      credentialsJson,
      false
    )
    if (options.signal?.aborted) {
      return abortedClaudeRateLimitResult()
    }
    if (refreshed) {
      credentialsJson = refreshed
      token = parseClaudeOAuthCredentialsJson(refreshed, 'credentials-file').token
    }
  }

  if (!token) {
    return noClaudeManagedCredentialsResult()
  }
  let oauthLimits = await readInactiveClaudeOAuthUsage(account.id, token, options.signal)
  // Why: a 401 can arrive while expiresAt is still in the future. One refresh
  // then a second usage read turns that into session/weekly windows. A refresh
  // that already ran (or returned nothing) is not tried again.
  if (
    !options.signal?.aborted &&
    oauthLimits.usageMetadata?.failureKind === 'stale-token' &&
    !refreshedThisCall
  ) {
    const refreshed = await persistRefreshedInactiveCredentials(
      account.id,
      location,
      credentialsJson,
      true
    )
    if (options.signal?.aborted) {
      return abortedClaudeRateLimitResult()
    }
    if (refreshed) {
      const refreshedToken = parseClaudeOAuthCredentialsJson(refreshed, 'credentials-file').token
      if (refreshedToken) {
        credentialsJson = refreshed
        oauthLimits = await readInactiveClaudeOAuthUsage(account.id, refreshedToken, options.signal)
      }
    }
  }
  if (options.signal?.aborted || oauthLimits.status !== 'ok') {
    return oauthLimits
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

async function persistRefreshedInactiveCredentials(
  accountId: string,
  location: NonNullable<ReturnType<typeof resolveClaudeManagedCredentialsLocation>>,
  credentialsJson: string,
  refreshWhenCurrent: boolean
): Promise<string | null> {
  return withClaudeManagedCredentialRotation(accountId, async () => {
    const latest = await readClaudeManagedCredentialsJson(location)
    const source = latest ?? credentialsJson
    // Why: selection may already have stored a new access token while keeping
    // the same refresh token. Refreshing again would discard that access token.
    if (storedOauthCredentialDiffers(source, credentialsJson)) {
      return source
    }
    if (!refreshWhenCurrent && !isOauthTokenExpiring(source)) {
      return source
    }
    const refreshed = await refreshClaudeOauthCredentials(source)
    if (!refreshed) {
      return null
    }
    try {
      await writeClaudeManagedCredentialsJson(location, refreshed)
    } catch {
      // Keep the refreshed token for this fetch; a later poll can persist it.
    }
    return refreshed
  })
}

// Why: a failed OAuth read used to throw out of the inactive batch. The service
// then kept no row, so the account list rendered blank instead of the limit or
// a real status. The usage-panel supplement stays on the success path only —
// after a 401 there is no window to prove a CLI reading belongs to this account.
async function readInactiveClaudeOAuthUsage(
  accountId: string,
  token: string,
  signal: AbortSignal | undefined
): Promise<ProviderRateLimits> {
  try {
    return await fetchClaudeOAuthUsage(token, signal)
  } catch (error) {
    if (signal?.aborted) {
      return abortedClaudeRateLimitResult()
    }
    const classification = classifyClaudeOAuthUsageError(error)
    const retryAfterMs = error instanceof OAuthUsageError ? error.retryAfterMs : null
    return makeClaudeUsageResult(
      'error',
      error instanceof Error ? error.message : 'Claude usage is unavailable',
      {
        attemptedSources: ['oauth'],
        failureKind: classification.failureKind,
        authProvenance: `managed:${accountId}:inactive-preview`,
        retryAtMs: retryAfterMs ? Date.now() + retryAfterMs : undefined
      }
    )
  }
}

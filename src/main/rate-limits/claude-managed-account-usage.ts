import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import { getClaudeProfileRoutingAuthority } from '../claude-accounts/claude-profile-routing-authority'
import { ClaudeProfileSignInRequiredError } from '../claude-accounts/claude-profile-routing-owner'
import type { InactiveClaudeAccount } from './claude-managed-account-credentials'
import type { ClaudeManagedAccountUsageOptions } from './claude-usage-fetch-options'
import { fetchActiveClaudeRateLimits } from './claude-active-usage-fetch'
import { claudeUsageUnavailable, makeClaudeUsageResult } from './claude-usage-result'
import { filterPathsToRunningWslDistrosAsync } from '../wsl-running-path-filter'

export async function fetchInactiveClaudeAccountUsage(
  account: InactiveClaudeAccount,
  options: ClaudeManagedAccountUsageOptions = {}
): Promise<ProviderRateLimits> {
  let home: string
  try {
    const authority = getClaudeProfileRoutingAuthority()
    if (!authority) {
      throw new Error('Claude profile host is unavailable.')
    }
    home = authority.accountHome(account.id)
  } catch (error) {
    return error instanceof ClaudeProfileSignInRequiredError
      ? makeClaudeUsageResult('error', 'Sign in again to use this account.', {
          failureKind: 'missing-credentials',
          attemptedSources: []
        })
      : claudeUsageUnavailable()
  }
  // Why: a stopped distro parks a UNC read for minutes, and the inactive loop is sequential.
  if (
    account.managedAuthRuntime === 'wsl' &&
    (await filterPathsToRunningWslDistrosAsync([home], { requireConfirmed: true })).length === 0
  ) {
    return claudeUsageUnavailable()
  }
  const read = fetchActiveClaudeRateLimits({
    signal: options.signal,
    authPreparation: {
      configDir: home,
      runtime: account.managedAuthRuntime,
      wslDistro: account.wslDistro,
      envPatch: { CLAUDE_CONFIG_DIR: home },
      stripAuthEnv: true,
      provenance: `profile:${account.id}`
    }
  })
  if (account.managedAuthRuntime !== 'wsl') {
    return read
  }
  const timeout = AbortSignal.timeout(INACTIVE_WSL_READ_TIMEOUT_MS)
  return Promise.race([
    read,
    new Promise<ProviderRateLimits>((resolve) =>
      timeout.addEventListener('abort', () => resolve(claudeUsageUnavailable()), { once: true })
    )
  ])
}

const INACTIVE_WSL_READ_TIMEOUT_MS = 10_000

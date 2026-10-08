import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import { getClaudeProfileRouter } from '../claude-accounts/claude-profile-installed-router'
import { savedWslClaudeAccountHome } from '../claude-accounts/claude-profile-wsl-paths'
import { toWindowsWslPath } from '../../shared/wsl-paths'
import type { ClaudeManagedAccountUsageOptions } from './claude-usage-fetch-options'
import { fetchActiveClaudeRateLimits } from './claude-active-usage-fetch'
import { claudeUsageUnavailable, makeClaudeUsageResult } from './claude-usage-result'
import { filterPathsToRunningWslDistrosAsync } from '../wsl-running-path-filter'

/** Usage reads the account's own folder; a host account's comes from its id, never a stored path. */
export type InactiveClaudeAccount = {
  id: string
  managedAuthRuntime?: 'host' | 'wsl'
  wslDistro?: string | null
  wslLinuxAuthPath?: string | null
}

export async function fetchInactiveClaudeAccountUsage(
  account: InactiveClaudeAccount,
  options: ClaudeManagedAccountUsageOptions = {}
): Promise<ProviderRateLimits> {
  const configDir =
    account.managedAuthRuntime === 'wsl'
      ? savedWslClaudeAccountHome(account)
      : (getClaudeProfileRouter()?.accountHome(account.id) ?? null)
  if (!configDir || (account.managedAuthRuntime === 'wsl' && !account.wslDistro)) {
    return makeClaudeUsageResult('error', 'Sign in again to use this account.', {
      failureKind: 'missing-credentials',
      attemptedSources: []
    })
  }
  const home =
    account.managedAuthRuntime === 'wsl' && account.wslDistro
      ? toWindowsWslPath(configDir, account.wslDistro)
      : configDir
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
      envPatch: { CLAUDE_CONFIG_DIR: configDir },
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

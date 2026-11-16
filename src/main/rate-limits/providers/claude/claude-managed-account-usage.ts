import type { ProviderRateLimits } from '../../../../shared/agent-usage/rate-limits/rate-limit-types'
import {
  getClaudeProfileRouter,
  getClaudeWslProfileRouter
} from '../../../claude-accounts/profiles/routing/claude-profile-installed-router'
import { toWindowsWslPath } from '../../../../shared/file-access/wsl-paths'
import type { ClaudeManagedAccountUsageOptions } from './claude-usage-fetch-options'
import { fetchActiveClaudeRateLimits } from './claude-active-usage-fetch'
import { claudeUsageUnavailable, makeClaudeUsageResult } from './claude-usage-result'
import { blockedWslDistroForPath } from '../../../wsl/filesystem/wsl-unc-access-gate'

/** Derive host account folders from account ids, never stored paths. */
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
  const limits = await readInactiveClaudeAccountUsage(account, options)
  // A failure before any login was read still belongs to the account it was for.
  return limits.usageMetadata?.attemptedAccount || limits.status === 'ok'
    ? limits
    : withAttemptedAccount(limits, account)
}

function withAttemptedAccount(
  limits: ProviderRateLimits,
  account: InactiveClaudeAccount
): ProviderRateLimits {
  if (account.managedAuthRuntime === 'wsl' && !account.wslDistro) {
    return limits
  }
  const attemptedAccount =
    account.managedAuthRuntime === 'wsl'
      ? { accountId: account.id, runtime: 'wsl' as const, wslDistro: account.wslDistro ?? null }
      : { accountId: account.id, runtime: 'host' as const, wslDistro: null }
  return { ...limits, usageMetadata: { ...limits.usageMetadata, attemptedAccount } }
}

async function readInactiveClaudeAccountUsage(
  account: InactiveClaudeAccount,
  options: ClaudeManagedAccountUsageOptions
): Promise<ProviderRateLimits> {
  if (account.managedAuthRuntime !== 'wsl') {
    // Covered accounts share System Default usage and launch routing.
    const authPreparation = getClaudeProfileRouter()?.accountUsagePreparation(account.id)
    return authPreparation
      ? fetchActiveClaudeRateLimits({ signal: options.signal, authPreparation })
      : signInAgain()
  }
  const distro = account.wslDistro
  const router = getClaudeWslProfileRouter()
  if (!distro || !router) {
    return signInAgain()
  }
  // A stopped distro can block UNC reads for minutes and strand the sequential inactive-account loop.
  const guestRoot = toWindowsWslPath('/', distro)
  // A list still naming a stopping distro must not let the reads below boot it (E9).
  if (await blockedWslDistroForPath(guestRoot)) {
    return claudeUsageUnavailable()
  }
  const timeout = AbortSignal.timeout(INACTIVE_WSL_READ_TIMEOUT_MS)
  const read = router
    .accountUsagePreparation(distro, account.id)
    .then((authPreparation) =>
      fetchActiveClaudeRateLimits({ signal: options.signal, authPreparation })
    )
    .catch(() => claudeUsageUnavailable())
  return Promise.race([
    read,
    new Promise<ProviderRateLimits>((resolve) =>
      timeout.addEventListener('abort', () => resolve(claudeUsageUnavailable()), { once: true })
    )
  ])
}

function signInAgain(): ProviderRateLimits {
  return makeClaudeUsageResult('error', 'Sign in again to use this account.', {
    failureKind: 'missing-credentials',
    attemptedSources: []
  })
}

const INACTIVE_WSL_READ_TIMEOUT_MS = 10_000

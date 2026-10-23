import { abortSignalWithTimeout } from '../lib/abort-signal-with-timeout'
import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import {
  getClaudeProfileRouter,
  getClaudeWslProfileRouter
} from '../claude-accounts/claude-profile-installed-router'
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
  options.signal?.throwIfAborted()
  if (account.managedAuthRuntime !== 'wsl') {
    // Why the router: a covered account's usage is System default's, as its launches are.
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
  // Why: a stopped distro parks a UNC read for minutes, and the inactive loop is sequential.
  const guestRoot = toWindowsWslPath('/', distro)
  const running = await filterPathsToRunningWslDistrosAsync([guestRoot], { requireConfirmed: true })
  options.signal?.throwIfAborted()
  if (running.length === 0) {
    return claudeUsageUnavailable()
  }
  const signal = abortSignalWithTimeout(options.signal, INACTIVE_WSL_READ_TIMEOUT_MS)
  try {
    const authPreparation = await waitForPromiseWithSignal(
      router.accountUsagePreparation(distro, account.id, signal),
      signal
    )
    signal.throwIfAborted()
    return await waitForPromiseWithSignal(
      fetchActiveClaudeRateLimits({ signal, authPreparation }),
      signal
    )
  } catch {
    options.signal?.throwIfAborted()
    return claudeUsageUnavailable()
  }
}

function signInAgain(): ProviderRateLimits {
  return makeClaudeUsageResult('error', 'Sign in again to use this account.', {
    failureKind: 'missing-credentials',
    attemptedSources: []
  })
}

const INACTIVE_WSL_READ_TIMEOUT_MS = 10_000

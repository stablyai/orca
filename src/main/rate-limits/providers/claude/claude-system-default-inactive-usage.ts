import type { ProviderRateLimits } from '../../../../shared/agent-usage/rate-limits/rate-limit-types'
import { claudeInactiveUsageReadsSystemDefault } from '../../../../shared/agent-accounts/claude/claude-system-default-inactive'
import { getClaudeProfileRouter } from '../../../claude-accounts/profiles/routing/claude-profile-installed-router'
import type { ClaudeManagedAccountUsageOptions } from './claude-usage-fetch-options'
import { fetchActiveClaudeRateLimits } from './claude-active-usage-fetch'
import { makeClaudeUsageResult } from './claude-usage-result'
import {
  fetchInactiveClaudeAccountUsage,
  type InactiveClaudeAccount
} from './claude-managed-account-usage'

export async function fetchClaudeSystemDefaultInactiveUsage(
  options: ClaudeManagedAccountUsageOptions = {}
): Promise<ProviderRateLimits> {
  const router = getClaudeProfileRouter()
  if (!router) {
    return makeClaudeUsageResult('error', 'Sign in again to use this account.', {
      failureKind: 'missing-credentials',
      attemptedSources: []
    })
  }
  // accountUsagePreparation(id) looks up a saved profile. System default has no saved id.
  return fetchActiveClaudeRateLimits({
    signal: options.signal,
    allowUsagePanelSupplement: options.allowUsagePanelSupplement,
    networkProxySettings: options.networkProxySettings,
    authPreparation: {
      configDir: router.systemDefaultHome(),
      envPatch: {},
      provenance: 'system'
    }
  })
}

export async function fetchInactiveClaudeMenuUsage(
  account: InactiveClaudeAccount,
  options: ClaudeManagedAccountUsageOptions = {}
): Promise<ProviderRateLimits> {
  if (claudeInactiveUsageReadsSystemDefault(account.id)) {
    return fetchClaudeSystemDefaultInactiveUsage(options)
  }
  return fetchInactiveClaudeAccountUsage(account, options)
}

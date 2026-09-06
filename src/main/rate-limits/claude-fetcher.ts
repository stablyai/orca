import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import { fetchActiveClaudeRateLimits } from './claude-active-usage-fetch'
import type { InactiveClaudeAccount } from './claude-managed-account-credentials'
import { fetchInactiveClaudeAccountUsage } from './claude-managed-account-usage'
import type {
  ClaudeManagedAccountUsageOptions,
  ClaudeRateLimitFetchOptions
} from './claude-usage-fetch-options'
import { ConsoleBalanceFetcher } from './console-balance-fetcher'
import type { ConsoleBalance } from '../../types/console-api'

export type FetchClaudeRateLimitsOptions = ClaudeRateLimitFetchOptions
export type FetchManagedAccountUsageOptions = ClaudeManagedAccountUsageOptions
export type InactiveClaudeAccountInfo = InactiveClaudeAccount

const consoleBalanceFetcher = new ConsoleBalanceFetcher()

export async function fetchConsoleBalance(
  apiKey: string,
  endpoint?: string,
  signal?: AbortSignal
): Promise<ConsoleBalance> {
  return consoleBalanceFetcher.fetch(apiKey, endpoint, signal)
}

export async function fetchClaudeRateLimits(
  options?: FetchClaudeRateLimitsOptions
): Promise<ProviderRateLimits> {
  return fetchActiveClaudeRateLimits(options)
}

export async function fetchManagedAccountUsage(
  account: InactiveClaudeAccountInfo,
  options: FetchManagedAccountUsageOptions = {}
): Promise<ProviderRateLimits> {
  return fetchInactiveClaudeAccountUsage(account, options)
}

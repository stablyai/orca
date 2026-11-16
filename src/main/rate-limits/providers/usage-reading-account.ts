import type {
  ProviderRateLimits,
  UsageReadingAccount
} from '../../../shared/agent-usage/rate-limits/rate-limit-types'

/** Names the account slot on a successful reading of its own login; every result names the attempt. */
export function withUsageReadingAccount(
  limits: ProviderRateLimits,
  readingAccount: UsageReadingAccount | undefined
): ProviderRateLimits {
  if (!readingAccount) {
    return limits
  }
  return {
    ...limits,
    usageMetadata: {
      ...limits.usageMetadata,
      attemptedAccount: readingAccount,
      ...(limits.status === 'ok' ? { readingAccount } : {})
    }
  }
}

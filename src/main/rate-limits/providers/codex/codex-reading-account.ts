import type {
  ProviderRateLimits,
  UsageReadingAccount
} from '../../../../shared/agent-usage/rate-limits/rate-limit-types'

/** Names the saved account on a successful reading of its own home; failures never carry it. */
export function withCodexReadingAccount(
  limits: ProviderRateLimits,
  readingAccount: UsageReadingAccount | undefined
): ProviderRateLimits {
  return readingAccount && limits.status === 'ok'
    ? { ...limits, usageMetadata: { ...limits.usageMetadata, readingAccount } }
    : limits
}

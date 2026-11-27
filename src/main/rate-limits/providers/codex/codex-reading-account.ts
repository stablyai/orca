import type {
  ProviderRateLimits,
  UsageReadingAccount
} from '../../../../shared/agent-usage/rate-limits/rate-limit-types'
import { isCodexUsageSignInRequired } from '../../../../shared/agent-accounts/codex/codex-auth-errors'

export function withCodexReadingAccount(
  limits: ProviderRateLimits,
  readingAccount: UsageReadingAccount | undefined
): ProviderRateLimits {
  if (!readingAccount) {
    return limits
  }
  if (limits.status === 'ok') {
    return { ...limits, usageMetadata: { ...limits.usageMetadata, readingAccount } }
  }
  if (limits.status === 'error' && isCodexUsageSignInRequired(limits)) {
    return {
      ...limits,
      usageMetadata: { ...limits.usageMetadata, authFailureAccount: readingAccount }
    }
  }
  return limits
}

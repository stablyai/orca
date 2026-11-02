import type { ProviderRateLimits, UsageRateLimitMetadata } from '../../shared/rate-limit-types'

export function abortedClaudeRateLimitResult(): ProviderRateLimits {
  return {
    provider: 'claude',
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error: 'Rate-limit fetch aborted',
    status: 'error'
  }
}

export function makeClaudeUsageResult(
  status: ProviderRateLimits['status'],
  error: string | null,
  metadata: UsageRateLimitMetadata
): ProviderRateLimits {
  return {
    provider: 'claude',
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error,
    status,
    usageMetadata: metadata
  }
}

// Account rows explain host/profile failures; usage keeps its generic message.
export function claudeUsageUnavailable(): ProviderRateLimits {
  return makeClaudeUsageResult('error', 'Claude usage is unavailable right now.', {
    failureKind: 'usage-unavailable',
    attemptedSources: []
  })
}

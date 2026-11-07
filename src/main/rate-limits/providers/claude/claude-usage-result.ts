import type {
  ProviderRateLimits,
  UsageRateLimitMetadata
} from '../../../../shared/rate-limit-types'

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

// Not idle: the meter draws idle as pending, and nothing here will settle it.
export function claudeOAuthUsageDisabledResult(): ProviderRateLimits {
  return makeClaudeUsageResult('unavailable', 'Usage appears when a Claude session runs.', {
    failureKind: 'usage-unavailable',
    attemptedSources: []
  })
}

// Account rows explain host/profile failures; usage keeps its generic message.
export function claudeUsageUnavailable(): ProviderRateLimits {
  return makeClaudeUsageResult('error', 'Claude usage is unavailable right now.', {
    failureKind: 'usage-unavailable',
    attemptedSources: []
  })
}

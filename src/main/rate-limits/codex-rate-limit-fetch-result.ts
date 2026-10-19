import type { ProviderRateLimits } from '../../shared/rate-limit-types'

export function codexRateLimitErrorResult(error: string): ProviderRateLimits {
  return {
    provider: 'codex',
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error,
    status: 'error'
  }
}

export function abortedCodexRateLimitResult(): ProviderRateLimits {
  return codexRateLimitErrorResult('Rate-limit fetch aborted')
}

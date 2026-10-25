import type { UsageRateLimitFailureKind } from '../../shared/rate-limit-types'

export function classifyThrownUsageRequestError(
  error: unknown
): Extract<UsageRateLimitFailureKind, 'network' | 'parse'> {
  // JSON parsing and transport throw through the same request boundary.
  return error instanceof SyntaxError ? 'parse' : 'network'
}

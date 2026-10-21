import type { UsageRateLimitFailureKind } from '../../shared/rate-limit-types'

/** Kind for an error thrown by a usage request, before or while reading its response. */
export function classifyThrownUsageRequestError(
  error: unknown
): Extract<UsageRateLimitFailureKind, 'network' | 'parse'> {
  // Why: a malformed JSON body throws from the same try as the transport.
  return error instanceof SyntaxError ? 'parse' : 'network'
}

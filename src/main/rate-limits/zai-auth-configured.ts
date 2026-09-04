import type { ProviderRateLimits } from '../../shared/rate-limit-types'

/**
 * Derive the durable `zaiAuthConfigured` flag from a settled Z.AI fetch result
 * instead of re-reading opencode's auth store — the fetcher already read it,
 * so a second probe per cycle would duplicate the auth-file read.
 */
export function deriveZaiAuthConfigured(limits: ProviderRateLimits | null): boolean {
  if (!limits) {
    return false
  }
  // Why: only definitive absence hides the row; auth-store read failures keep it
  // discoverable because they do not prove the Coding Plan key is unconfigured.
  if (limits.usageMetadata?.failureKind === 'missing-credentials') {
    return false
  }
  return limits.status !== 'unavailable'
}

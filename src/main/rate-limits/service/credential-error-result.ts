import type { ProviderRateLimits } from '../../../shared/agent-usage/rate-limits/rate-limit-types'

export function credentialUnavailableResult(
  provider: 'minimax' | 'zcode',
  message: string
): ProviderRateLimits {
  return {
    provider,
    session: null,
    weekly: null,
    ...(provider === 'zcode' ? { monthly: null } : {}),
    updatedAt: Date.now(),
    error: message,
    status: 'error',
    usageMetadata: { failureKind: 'keychain-unavailable', source: 'web' }
  }
}

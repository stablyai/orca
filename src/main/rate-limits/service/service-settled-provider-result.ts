import type { ProviderRateLimits } from './service-types'

export function providerResultFromSettled(
  provider: ProviderRateLimits['provider'],
  settled: PromiseSettledResult<ProviderRateLimits>
): ProviderRateLimits {
  if (settled.status === 'fulfilled') {
    return settled.value
  }
  return {
    provider,
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error: settled.reason instanceof Error ? settled.reason.message : 'Unknown error',
    status: 'error'
  }
}

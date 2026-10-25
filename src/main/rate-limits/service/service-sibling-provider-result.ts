import type { ProviderRateLimits } from './service-types'

export type SettledProviderResult =
  | { status: 'fulfilled'; value: ProviderRateLimits }
  | { status: 'rejected'; reason: unknown }

export function settleSiblingProviderResult(
  provider: ProviderRateLimits['provider'],
  settled: SettledProviderResult
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

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

/** Shared tail for sibling fetch promises; keeps each provider block two lines shorter. */
export function settledProviderResult(
  fetch: Promise<ProviderRateLimits>
): Promise<SettledProviderResult> {
  return fetch.then(
    (value) => ({ status: 'fulfilled', value }) as const,
    (reason) => ({ status: 'rejected', reason }) as const
  )
}

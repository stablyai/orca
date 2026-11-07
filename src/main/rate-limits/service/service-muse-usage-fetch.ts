import type { ProviderRateLimits } from './service-types'
import { fetchMuseRateLimits } from '../muse-usage-fetcher'
import { settleSiblingProviderFetch } from './service-sibling-provider-result'

export function prepareMuseUsageFetch(
  signal: AbortSignal,
  enabled: boolean,
  previous: ProviderRateLimits
) {
  return settleSiblingProviderFetch(
    enabled ? fetchMuseRateLimits({ signal }) : Promise.resolve(previous)
  )
}

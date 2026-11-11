import type { ProviderRateLimits } from '../../../shared/rate-limit-types'
import { fetchMuseRateLimits } from '../providers/muse/muse-usage-fetcher'
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

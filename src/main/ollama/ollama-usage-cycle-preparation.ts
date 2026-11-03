import {
  fetchOllamaCloudRateLimits,
  ollamaCloudMissingCredentials
} from '../rate-limits/ollama-usage-fetcher'
import { readOllamaCloudApiKey } from './ollama-cloud-api-key-store'
import { settledProviderResult } from '../rate-limits/service/service-sibling-provider-result'
import type { SettledProviderResult } from '../rate-limits/service/service-sibling-provider-result'

/** One API key, no account switcher: read inside the cycle so a save mid-cycle starts next round. */
export function prepareOllamaResultPromise(signal: AbortSignal): Promise<SettledProviderResult> {
  const apiKey = readOllamaCloudApiKey()
  return settledProviderResult(
    apiKey
      ? fetchOllamaCloudRateLimits({ apiKey, signal })
      : Promise.resolve(ollamaCloudMissingCredentials())
  )
}

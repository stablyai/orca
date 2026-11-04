import {
  fetchOllamaCloudRateLimits,
  ollamaCloudMissingCredentials
} from '../rate-limits/ollama-usage-fetcher'
import { readOllamaCloudApiKey } from './ollama-cloud-api-key-store'
import { settledProviderResult } from '../rate-limits/service/service-sibling-provider-result'
import type { SettledProviderResult } from '../rate-limits/service/service-sibling-provider-result'

/** One API key, no account switcher: read inside the cycle so a save mid-cycle starts next round.
 *  An unreadable/decryption-failed key is an Ollama-only error; it must never reject the cycle. */
export function prepareOllamaResultPromise(signal: AbortSignal): Promise<SettledProviderResult> {
  let apiKey: string | null = null
  try {
    apiKey = readOllamaCloudApiKey()
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Ollama cloud API key unreadable'
    // A key saved on another host (sealed-elsewhere) or an undecryptable envelope stays
    // dead until the user re-saves; polling it as retryable 'error' would spend every
    // activation window on a fetch that cannot succeed.
    return Promise.resolve({
      status: 'fulfilled',
      value: {
        ...ollamaCloudMissingCredentials(),
        error: message
      }
    })
  }
  return settledProviderResult(
    apiKey
      ? fetchOllamaCloudRateLimits({ apiKey, signal })
      : Promise.resolve(ollamaCloudMissingCredentials())
  )
}

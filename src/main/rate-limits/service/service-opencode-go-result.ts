import type { ProviderRateLimits } from './service-types'

export function applyOpenCodeGoApiKeyError(
  result: PromiseSettledResult<ProviderRateLimits>,
  apiKeyError: string | null
): void {
  // Why: preserve a cookie diagnosis or usable quota when only the saved key could not be decrypted.
  if (apiKeyError && result.status === 'fulfilled' && result.value.status === 'unavailable') {
    result.value = {
      ...result.value,
      error: apiKeyError,
      status: 'error'
    }
  }
}

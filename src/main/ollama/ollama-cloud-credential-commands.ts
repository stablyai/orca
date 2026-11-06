/** Ollama cloud usage credential commands; Ollama has no CLI sign-in to fall back to — API key only. */
import {
  clearOllamaCloudApiKey,
  getOllamaCloudApiKeyProtection,
  hasOllamaCloudApiKey,
  OLLAMA_CLOUD_API_KEY_ENVELOPE_PREFIX,
  getOllamaCloudApiKeyPath,
  saveOllamaCloudApiKey
} from './ollama-cloud-api-key-store'
import {
  refuseCredentialSealedElsewhere,
  savedCredentialUnreadable
} from '../credentials/saved-credential-readability'
import { refreshAfterCredentialChange } from '../ipc/credential-change-rate-limit-refresh'
import type { RateLimitService } from '../rate-limits/service'
import type { OllamaCloudCredentialsStatus } from '../../shared/ollama-cloud'

type UsageRefresher = Pick<RateLimitService, 'refresh' | 'invalidateOllamaCredentialState'>

export function getOllamaCloudCredentialsStatus(): OllamaCloudCredentialsStatus {
  const apiKeyConfigured = hasOllamaCloudApiKey()
  return {
    apiKeyConfigured,
    apiKeyProtection: getOllamaCloudApiKeyProtection(),
    apiKeyUnreadable: apiKeyConfigured ? apiKeyUnreadable() : undefined
  }
}

function apiKeyUnreadable(): ReturnType<typeof savedCredentialUnreadable> {
  return savedCredentialUnreadable({
    path: getOllamaCloudApiKeyPath(),
    envelopePrefix: OLLAMA_CLOUD_API_KEY_ENVELOPE_PREFIX
  })
}

/** Reject save when this host cannot open the existing seal; forgetting remains allowed. */
export function assertOllamaCloudApiKeyOpensHere(): void {
  if (apiKeyUnreadable() === 'sealed-elsewhere') {
    refuseCredentialSealedElsewhere('Ollama cloud API key')
  }
}

function refreshAfterChange(rateLimits: UsageRefresher | null, action: 'save' | 'clear'): void {
  refreshAfterCredentialChange(
    rateLimits,
    (service) => service.invalidateOllamaCredentialState(),
    `[ollama] failed to trigger rate-limit refresh after ${action}:`
  )
}

export function saveOllamaCloudApiKeyCredential(
  rateLimits: UsageRefresher | null,
  key: unknown
): OllamaCloudCredentialsStatus {
  // Runtime-check IPC/RPC input; compile-time types do not constrain the wire.
  if (typeof key !== 'string') {
    throw new Error('Ollama cloud API key must be a string')
  }
  saveOllamaCloudApiKey(key)
  refreshAfterChange(rateLimits, 'save')
  return getOllamaCloudCredentialsStatus()
}

export function clearOllamaCloudApiKeyCredential(
  rateLimits: UsageRefresher | null
): OllamaCloudCredentialsStatus {
  clearOllamaCloudApiKey()
  refreshAfterChange(rateLimits, 'clear')
  return getOllamaCloudCredentialsStatus()
}

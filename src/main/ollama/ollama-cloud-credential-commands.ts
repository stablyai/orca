/** Ollama cloud usage credential commands; Ollama has no CLI sign-in to fall back to — API key only. */
import {
  clearOllamaCloudApiKey,
  getOllamaCloudApiKeyProtection,
  hasOllamaCloudApiKeyAsync,
  OLLAMA_CLOUD_API_KEY_ENVELOPE_PREFIX,
  getOllamaCloudApiKeyPath,
  saveOllamaCloudApiKey
} from './ollama-cloud-api-key-store'
import {
  refuseCredentialSealedElsewhere,
  savedCredentialUnreadableAsync
} from '../credentials/saved-credential-readability'
import { refreshAfterCredentialChange } from '../ipc/accounts/credential-change-rate-limit-refresh'
import type { RateLimitService } from '../rate-limits/service/rate-limit-service'
import type { OllamaCloudCredentialsStatus } from '../../shared/ollama-cloud'

type UsageRefresher = Pick<RateLimitService, 'refresh' | 'invalidateOllamaCredentialState'>

export async function getOllamaCloudCredentialsStatus(): Promise<OllamaCloudCredentialsStatus> {
  const apiKeyConfigured = await hasOllamaCloudApiKeyAsync()
  return {
    apiKeyConfigured,
    apiKeyProtection: await getOllamaCloudApiKeyProtection(),
    apiKeyUnreadable: apiKeyConfigured ? await apiKeyUnreadable() : undefined
  }
}

function apiKeyUnreadable(): ReturnType<typeof savedCredentialUnreadableAsync> {
  return savedCredentialUnreadableAsync({
    path: getOllamaCloudApiKeyPath(),
    envelopePrefix: OLLAMA_CLOUD_API_KEY_ENVELOPE_PREFIX
  })
}

/** Reject save when this host cannot open the existing seal; forgetting remains allowed. */
export async function assertOllamaCloudApiKeyOpensHere(): Promise<void> {
  if ((await apiKeyUnreadable()) === 'sealed-elsewhere') {
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

export async function saveOllamaCloudApiKeyCredential(
  rateLimits: UsageRefresher | null,
  key: unknown
): Promise<OllamaCloudCredentialsStatus> {
  // Runtime-check IPC/RPC input; compile-time types do not constrain the wire.
  if (typeof key !== 'string') {
    throw new Error('Ollama cloud API key must be a string')
  }
  await assertOllamaCloudApiKeyOpensHere()
  await saveOllamaCloudApiKey(key)
  refreshAfterChange(rateLimits, 'save')
  return getOllamaCloudCredentialsStatus()
}

export async function clearOllamaCloudApiKeyCredential(
  rateLimits: UsageRefresher | null
): Promise<OllamaCloudCredentialsStatus> {
  await clearOllamaCloudApiKey()
  refreshAfterChange(rateLimits, 'clear')
  return getOllamaCloudCredentialsStatus()
}

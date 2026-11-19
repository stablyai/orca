import { createEncryptedApiKeyFileStoreAsync } from '../credentials/encrypted-api-key-file-store-async'

export const OLLAMA_CLOUD_API_KEY_ENVELOPE_PREFIX = 'orca-ollama-cloud-api-key:v1:'

const store = createEncryptedApiKeyFileStoreAsync({
  fileName: 'ollama-cloud-api-key.enc',
  envelopePrefix: OLLAMA_CLOUD_API_KEY_ENVELOPE_PREFIX,
  providerLabel: 'Ollama cloud',
  logScope: 'ollama',
  singleLine: true,
  requireRestrictedPlaintext: true
})

export const getOllamaCloudApiKeyPath = () => store.envelopeFile().path
export const hasOllamaCloudApiKey = store.hasCached
export const hasOllamaCloudApiKeyAsync = store.has
export const getOllamaCloudApiKeyProtection = store.protection
export const saveOllamaCloudApiKey = store.save
export const readOllamaCloudApiKey = store.read
export const clearOllamaCloudApiKey = store.clear

import { createEncryptedApiKeyFileStore } from '../credentials/encrypted-api-key-file-store'
import { savedCredentialUnreadable } from '../credentials/saved-credential-readability'

const store = createEncryptedApiKeyFileStore({
  fileName: 'soniox-speech-key.enc',
  envelopePrefix: 'orca-soniox-speech:v1:',
  providerLabel: 'Soniox',
  logScope: 'speech'
})

export const hasSonioxSpeechApiKey = store.has
export const clearSonioxSpeechApiKey = store.clear
export const getSonioxSpeechApiKeyProtection = store.protection
export const sonioxSpeechApiKeyEnvelopeFile = store.envelopeFile

export async function saveSonioxSpeechApiKey(apiKey: string): Promise<void> {
  const trimmed = apiKey.trim()
  if (!trimmed) {
    throw new Error('Soniox API key is required')
  }
  await store.save(trimmed)
}

export async function readSonioxSpeechApiKey(): Promise<string> {
  // The store caches what it read; another process (desktop vs orca serve) may have removed the file since.
  const key = (await store.has()) ? await store.read() : null
  if (!key) {
    throw new Error('Soniox API key is not configured')
  }
  return key
}

/** Headless hosts may not open a desktop-sealed file; checks the disk quietly, since readiness is polled. */
export async function canReadSonioxSpeechApiKey(): Promise<boolean> {
  return (
    (await store.has()) && (await savedCredentialUnreadable(store.envelopeFile())) === undefined
  )
}

import type { SpeechModelProvider } from '../../shared/speech-types'
import { hasElevenLabsSpeechApiKey } from './elevenlabs-api-key-store'
import { hasOpenAiSpeechApiKey } from './openai-api-key-store'

/**
 * Why: a cloud model has nothing to download, so "ready" means the credential its provider
 * needs already exists. Centralizing the mapping stops the model manager and the settings UI
 * from disagreeing about which key a given catalog entry requires.
 */
export function hasCloudSpeechApiKey(provider: SpeechModelProvider): boolean {
  switch (provider) {
    case 'openai':
      return hasOpenAiSpeechApiKey()
    case 'elevenlabs':
      return hasElevenLabsSpeechApiKey()
    case 'local':
      return false
  }
}

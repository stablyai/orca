import type { RpcClient } from '../transport/rpc-client'
import {
  fetchDictationSetup,
  setDictationConfig,
  downloadDictationModel,
  deleteDictationModel
} from '../dictation/mobile-dictation-setup'
import {
  clearSpeechProviderKey,
  fetchSpeechProviders,
  saveSpeechProviderKey,
  setSpeechTranscriptionLanguage,
  testSpeechProviderKey
} from '../dictation/mobile-speech-providers'
import type { VoiceSettingsOperations } from './voice-settings-operations'

export function nativeVoiceSettingsOperations(client: RpcClient): VoiceSettingsOperations {
  return {
    load: () => fetchDictationSetup(client),
    configure: (params) => setDictationConfig(client, params),
    download: (modelId) => downloadDictationModel(client, modelId),
    delete: (modelId) => deleteDictationModel(client, modelId),
    providers: {
      list: () => fetchSpeechProviders(client),
      saveKey: (providerId, apiKey) => saveSpeechProviderKey(client, providerId, apiKey),
      clearKey: (providerId) => clearSpeechProviderKey(client, providerId),
      testKey: (providerId) => testSpeechProviderKey(client, providerId),
      setLanguage: (language) => setSpeechTranscriptionLanguage(client, language)
    }
  }
}

import type { MobileSpeechSetup } from '../dictation/mobile-dictation-setup'
import type {
  MobileSpeechProviderKeyTest,
  MobileSpeechProvidersState
} from '../dictation/speech-provider-reply-schema'

export interface VoiceProviderOperations {
  /** Null when the paired desktop predates the provider cabinet. */
  list(): Promise<MobileSpeechProvidersState | null>
  saveKey(providerId: string, apiKey: string): Promise<MobileSpeechProvidersState>
  clearKey(providerId: string): Promise<MobileSpeechProvidersState>
  testKey(providerId: string): Promise<MobileSpeechProviderKeyTest>
  setLanguage(language: string): Promise<MobileSpeechProvidersState>
}

export interface VoiceSettingsOperations {
  load(): Promise<MobileSpeechSetup>
  configure(params: {
    enabled?: boolean
    modelId?: string
    dictationMode?: 'toggle' | 'hold'
  }): Promise<MobileSpeechSetup>
  download(modelId: string): Promise<void>
  delete(modelId: string): Promise<MobileSpeechSetup>
  // Why: optional so a screen without it (or a test double) renders the legacy model list.
  providers?: VoiceProviderOperations
}

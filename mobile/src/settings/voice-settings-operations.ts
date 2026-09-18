import type { MobileSpeechSetup } from '../dictation/mobile-dictation-setup'

export interface VoiceSettingsOperations {
  load(): Promise<MobileSpeechSetup>
  configure(params: {
    enabled?: boolean
    modelId?: string
    dictationMode?: 'toggle' | 'hold'
  }): Promise<MobileSpeechSetup>
  download(modelId: string): Promise<void>
  delete(modelId: string): Promise<MobileSpeechSetup>
}

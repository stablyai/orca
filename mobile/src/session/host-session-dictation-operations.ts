import type { VoiceSettingsOperations } from '../settings/voice-settings-operations'
import type {
  MobileWebSpeechEvent,
  MobileWebSpeechStartResult,
  MobileWebSpeechStopResult
} from '../../../src/shared/mobile-web/speech-operation-contract'

export type HostSessionDictationSubscription = {
  ready: Promise<void>
  unsubscribe: () => void
}

export type HostSessionDictationOperations = {
  loadSetup: VoiceSettingsOperations['load']
  downloadModel: (modelId: string) => Promise<void>
  deleteModel: VoiceSettingsOperations['delete']
  configure: VoiceSettingsOperations['configure']
  subscribe: (
    onEvent: (event: MobileWebSpeechEvent) => void,
    onError: (error: Error) => void
  ) => HostSessionDictationSubscription
  start: () => Promise<MobileWebSpeechStartResult>
  stop: () => Promise<MobileWebSpeechStopResult>
  cancel: () => Promise<void>
}

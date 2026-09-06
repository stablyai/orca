import type {
  MobileWebSpeechConfigurePayload,
  MobileWebSpeechEvent,
  MobileWebSpeechSetup,
  MobileWebSpeechStartResult,
  MobileWebSpeechStopResult
} from '../../../src/shared/mobile-web/speech-operation-contract'

export type HostSessionDictationSubscription = {
  ready: Promise<void>
  unsubscribe: () => void
}

export type HostSessionDictationOperations = {
  loadSetup: () => Promise<MobileWebSpeechSetup>
  downloadModel: (modelId: string) => Promise<void>
  deleteModel: (modelId: string) => Promise<MobileWebSpeechSetup>
  configure: (payload: MobileWebSpeechConfigurePayload) => Promise<MobileWebSpeechSetup>
  subscribe: (
    onEvent: (event: MobileWebSpeechEvent) => void,
    onError: (error: Error) => void
  ) => HostSessionDictationSubscription
  start: () => Promise<MobileWebSpeechStartResult>
  stop: () => Promise<MobileWebSpeechStopResult>
  cancel: () => Promise<void>
}

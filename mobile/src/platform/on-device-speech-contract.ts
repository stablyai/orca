import type {
  BridgeSpeechFinish,
  BridgeSpeechRead,
  BridgeSpeechStartResult,
  BridgeSpeechStatusResult
} from '../mobile-web-shell/bridge/bridge-speech-verbs'

// The phone's own recognizer as dictation sees it, in the phone's language. Any rejection means "use the computer".
export type OnDeviceSpeech = {
  readonly status: () => Promise<BridgeSpeechStatusResult>
  readonly start: () => Promise<BridgeSpeechStartResult>
  readonly read: () => Promise<BridgeSpeechRead>
  readonly finish: () => Promise<BridgeSpeechFinish>
  readonly cancel: () => void
}

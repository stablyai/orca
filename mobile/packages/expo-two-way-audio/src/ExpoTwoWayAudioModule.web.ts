import { PermissionStatus, type PermissionResponse } from 'expo-modules-core'

type EventSubscription = {
  remove: () => void
}

type ExpoTwoWayAudioWebModule = {
  initialize: () => Promise<boolean>
  playPCMData: (audioData: Uint8Array) => void
  bypassVoiceProcessing: (bypass: boolean) => void
  toggleRecording: (val: boolean) => boolean
  isRecording: () => boolean
  tearDown: () => void
  restart: () => void
  getMicrophonePermissionsAsync: () => Promise<PermissionResponse>
  requestMicrophonePermissionsAsync: () => Promise<PermissionResponse>
  getMicrophoneModeIOS: () => null
  setMicrophoneModeIOS: () => void
  isPlaying: () => boolean
  stopPlayback: () => void
  pausePlayback: () => void
  resumePlayback: () => void
  addListener: (eventName: string, handler: (ev: unknown) => void) => EventSubscription
}

const deniedMicrophonePermission: PermissionResponse = {
  status: PermissionStatus.DENIED,
  expires: 'never',
  granted: false,
  canAskAgain: false
}

const noop = () => undefined

const ExpoTwoWayAudioModule: ExpoTwoWayAudioWebModule = {
  // Why: this is what a browser outside the Orca shell can honestly say. Dictation on the page no
  // longer comes through here — `src/platform/dictation-capture.web.ts` asks the shell for the
  // microphone over `native.audio.start|read|stop`, so the only importer of this package is the
  // native half of that seam. What is left is the QA web build, which has no shell to ask.
  initialize: async () => false,
  playPCMData: noop,
  bypassVoiceProcessing: noop,
  toggleRecording: () => false,
  isRecording: () => false,
  tearDown: noop,
  restart: noop,
  getMicrophonePermissionsAsync: async () => deniedMicrophonePermission,
  requestMicrophonePermissionsAsync: async () => deniedMicrophonePermission,
  getMicrophoneModeIOS: () => null,
  setMicrophoneModeIOS: noop,
  isPlaying: () => false,
  stopPlayback: noop,
  pausePlayback: noop,
  resumePlayback: noop,
  addListener: () => ({ remove: noop })
}

export default ExpoTwoWayAudioModule

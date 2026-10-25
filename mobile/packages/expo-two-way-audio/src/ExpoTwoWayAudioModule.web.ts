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
  // QA browser has no shell microphone; page dictation uses platform/dictation-capture.web.ts native.audio.start|read|stop instead.
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

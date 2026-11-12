import { PermissionStatus, type PermissionResponse } from 'expo-modules-core'

type EventSubscription = {
  remove: () => void
}

type ExpoTwoWayAudioWebModule = {
  initialize: () => Promise<boolean>
  bypassVoiceProcessing: (bypass: boolean) => void
  toggleRecording: (val: boolean) => boolean
  isRecording: () => boolean
  tearDown: () => void
  restart: () => void
  getMicrophonePermissionsAsync: () => Promise<PermissionResponse>
  requestMicrophonePermissionsAsync: () => Promise<PermissionResponse>
  getMicrophoneModeIOS: () => null
  setMicrophoneModeIOS: () => void
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
  bypassVoiceProcessing: noop,
  toggleRecording: () => false,
  isRecording: () => false,
  tearDown: noop,
  restart: noop,
  getMicrophonePermissionsAsync: async () => deniedMicrophonePermission,
  requestMicrophonePermissionsAsync: async () => deniedMicrophonePermission,
  getMicrophoneModeIOS: () => null,
  setMicrophoneModeIOS: noop,
  addListener: () => ({ remove: noop })
}

export default ExpoTwoWayAudioModule

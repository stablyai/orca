import {
  addExpoTwoWayAudioEventListener,
  initialize,
  requestMicrophonePermissionsAsync,
  tearDown,
  toggleRecording
} from '@orca/expo-two-way-audio'
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake'
import { BRIDGE_AUDIO_INTERRUPTIONS } from '../mobile-web-shell/bridge/bridge-audio-verbs'
import { createMicrophoneScreenLock } from './microphone-screen-lock'
import type { NativeAudioEngine } from './native-audio'

// Isolate device imports so tests can inject engines without loading a device-only JSI binding.

// initialize() accepts no rate: both engines produce fixed 16 kHz, so report the actual rate instead of silently accepting another.
export const NATIVE_AUDIO_DEVICE_SAMPLE_RATE = 16_000

const MICROPHONE_SCREEN_LOCK_TAG = 'orca-microphone'

// Share one wake lock for the one microphone; native and bridge capture must not use independently releasable tags.
export const nativeMicrophoneScreenLock = createMicrophoneScreenLock(
  { activate: activateKeepAwakeAsync, deactivate: deactivateKeepAwake },
  MICROPHONE_SCREEN_LOCK_TAG
)

function readInterruption(data: string): (typeof BRIDGE_AUDIO_INTERRUPTIONS)[number] | null {
  return BRIDGE_AUDIO_INTERRUPTIONS.find((kind) => kind === data) ?? null
}

export const nativeAudioDeviceEngine: NativeAudioEngine = {
  requestPermission: async () => {
    const permission = await requestMicrophonePermissionsAsync()
    // Permission refusal has the same page outcome whether or not the OS allows another prompt.
    return permission.granted ? 'granted' : permission.canAskAgain ? 'undetermined' : 'denied'
  },
  open: async (sampleRate) => ({
    opened: sampleRate === NATIVE_AUDIO_DEVICE_SAMPLE_RATE && (await initialize()),
    sampleRate: NATIVE_AUDIO_DEVICE_SAMPLE_RATE
  }),
  begin: () => toggleRecording(true),
  end: () => {
    toggleRecording(false)
    tearDown()
  },
  screenLock: nativeMicrophoneScreenLock,
  onMicrophoneData: (handler) =>
    addExpoTwoWayAudioEventListener('onMicrophoneData', (event) => {
      const raw = event.data
      handler(raw instanceof Uint8Array ? raw : new Uint8Array(raw))
    }),
  onInterruption: (handler) =>
    addExpoTwoWayAudioEventListener('onAudioInterruption', (event) => {
      // Ignore unknown engine interruption kinds instead of forwarding a value the page cannot describe.
      const kind = readInterruption(event.data)
      if (kind !== null) {
        handler(kind)
      }
    })
}

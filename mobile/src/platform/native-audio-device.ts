import {
  addExpoTwoWayAudioEventListener,
  initialize,
  requestMicrophonePermissionsAsync,
  tearDown,
  toggleRecording
} from '@orca/expo-two-way-audio'
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake'
import { BRIDGE_AUDIO_INTERRUPTIONS } from '../mobile-web-shell/bridge/bridge-audio-verbs'
import type { NativeAudioEngine } from './native-audio'
import type { WakelockDevice } from './native-wakelock'

/**
 * The device calls the audio and wake-lock verbs actually make.
 *
 * Separated from the servers for the media device's reason: importing `@orca/expo-two-way-audio`
 * reaches a JSI binding that only exists in a device build, so a module naming it cannot be driven
 * in a unit test at all — and the platform facts worth naming are here rather than spread through
 * the handler.
 */

/**
 * The rate the engine actually opened at.
 *
 * `initialize()` takes no rate and answers a boolean: both engines open at their own fixed rate,
 * which is the 16 kHz the desktop transcribes at and the one `MOBILE_DICTATION_PCM_SAMPLE_RATE`
 * already names. So the asked-for rate is honoured only when it is that one, and anything else is
 * answered with what the device will really produce rather than accepted and then ignored.
 */
export const NATIVE_AUDIO_DEVICE_SAMPLE_RATE = 16_000

function readInterruption(data: string): (typeof BRIDGE_AUDIO_INTERRUPTIONS)[number] | null {
  return BRIDGE_AUDIO_INTERRUPTIONS.find((kind) => kind === data) ?? null
}

export const nativeAudioDeviceEngine: NativeAudioEngine = {
  requestPermission: async () => {
    const permission = await requestMicrophonePermissionsAsync()
    // The prompt is the OS's, run inside `start`, and this is what it decided. `canAskAgain` on a
    // refusal is the "ask again later" state, which the page cannot act on differently: either way
    // it has no microphone now and shows the same screen.
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
  onMicrophoneData: (handler) =>
    addExpoTwoWayAudioEventListener('onMicrophoneData', (event) => {
      const raw = event.data
      handler(raw instanceof Uint8Array ? raw : new Uint8Array(raw))
    }),
  onInterruption: (handler) =>
    addExpoTwoWayAudioEventListener('onAudioInterruption', (event) => {
      // A kind this build has no name for is not reported: the page switches over the list, and a
      // string from a newer engine would reach it as an interruption it cannot describe.
      const kind = readInterruption(event.data)
      if (kind !== null) {
        handler(kind)
      }
    })
}

export const nativeWakelockDevice: WakelockDevice = {
  activate: (tag) => activateKeepAwakeAsync(tag),
  deactivate: (tag) => deactivateKeepAwake(tag)
}

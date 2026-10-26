import {
  addExpoTwoWayAudioEventListener,
  initialize,
  requestMicrophonePermissionsAsync,
  tearDown,
  toggleRecording
} from '@orca/expo-two-way-audio'
import { bridgeAudioInterruptionEndsCapture } from '../mobile-web-shell/bridge/bridge-audio-verbs'
import { nativeMicrophoneScreenLock } from './native-audio-device'
import type { DictationCapture } from './dictation-capture-contract'

const screen = nativeMicrophoneScreenLock

const nativeDictationCapture: DictationCapture = {
  open: async () => {
    const permission = await requestMicrophonePermissionsAsync()
    if (!permission.granted) {
      return { ok: false, reason: 'permission-denied' }
    }
    if (!(await initialize())) {
      return { ok: false, reason: 'unavailable' }
    }
    // Hold the screen from successful open; end/release free it, and failed opens acquire nothing.
    screen.hold()
    return { ok: true }
  },
  begin: () => toggleRecording(true),
  // Native events already delivered the tail. Catch binding throws inside this async cleanup because void callers’ synchronous try cannot catch rejections.
  end: async () => {
    screen.release()
    try {
      toggleRecording(false)
    } catch (error) {
      console.error('Failed to stop microphone recording', error)
    }
  },
  // Unmount calls release bare; catch failures so wake-tag release and desktop cancel can still run.
  release: () => {
    screen.release()
    try {
      tearDown()
    } catch (error) {
      console.error('Failed to tear down the audio session', error)
    }
  },
  onChunk: (handler) =>
    addExpoTwoWayAudioEventListener('onMicrophoneData', (event) => {
      const raw = event.data
      handler({
        data: raw instanceof Uint8Array ? raw : new Uint8Array(raw),
        // Native events lose no bytes at this seam; pending-budget refusal accounts for downstream overload.
        droppedBytes: 0
      })
    }),
  onInterruption: (handler) =>
    addExpoTwoWayAudioEventListener('onAudioInterruption', (event) => {
      if (bridgeAudioInterruptionEndsCapture(event.data)) {
        handler()
      }
    })
}

export function useDictationCapture(): DictationCapture {
  return nativeDictationCapture
}

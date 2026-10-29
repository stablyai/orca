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

// Never throw: unmount calls this bare and `end` must not reject, so wake-tag release and desktop cancel still run.
function releaseMicrophone(): void {
  screen.release()
  try {
    tearDown()
  } catch (error) {
    console.error('Failed to tear down the audio session', error)
  }
}

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
  // Native events already delivered the tail. Tear down, not just mute, so other apps' audio resumes; the next open re-initializes.
  end: async () => releaseMicrophone(),
  release: releaseMicrophone,
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

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

/**
 * The device's microphone, which is where dictation's audio has always come from.
 *
 * Every call is the one the hook used to make, in the order it made it, because this half is the
 * seam's shape rather than a translation of it: a permission and an open, a start and a stop, and
 * the two event lanes `@orca/expo-two-way-audio` emits. What moved is where they are written, so
 * the page can answer the same shape without the flow above knowing which it holds.
 */

/** The same lock the shell's capture holds: one microphone, one screen, one tag. */
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
    // The mic is open from here, so the screen is held from here; `end` and `release` both give it
    // back, and a capture that never opened holds nothing.
    screen.hold()
    return { ok: true }
  },
  begin: () => toggleRecording(true),
  /**
   * Already resolved: every microphone event reached the hook as the engine produced it, so there
   * is nothing held back for a stop to hand over.
   *
   * And it never rejects, which the contract promises because of how it is called: every site
   * reaches it as `void capture.end()` inside a synchronous `try`, which cannot see a rejection. A
   * binding that threw left an unhandled rejection rather than a logged failure, so the throw is
   * swallowed here where there is somewhere to log it.
   */
  end: async () => {
    screen.release()
    try {
      toggleRecording(false)
    } catch (error) {
      console.error('Failed to stop microphone recording', error)
    }
  },
  /** Same reason, and a sharper one: this runs bare in the unmount path, where a throw would take
   *  the rest of the cleanup — the wake tag and the desktop's cancel — with it. */
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
        // Nothing is ever dropped on the way here: this process is where the microphone is, and
        // what the flow cannot keep up with is the pending-audio budget's to refuse, not this.
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

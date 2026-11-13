import {
  addExpoTwoWayAudioEventListener,
  speechAvailability,
  speechCancel,
  speechFinish,
  speechStart
} from '@orca/expo-two-way-audio'
import { loadDictationEnginePreference } from '../../storage/dictation-engine-preference'
import { NATIVE_AUDIO_DEVICE_SAMPLE_RATE } from '../audio-capture/native-audio-device'
import type { NativeSpeechEngine } from './native-speech'

// Isolate the device module so tests drive the server with a fake engine.
export const nativeSpeechDeviceEngine: NativeSpeechEngine = {
  availability: (locale) => speechAvailability(locale),
  start: (locale) => speechStart(locale, NATIVE_AUDIO_DEVICE_SAMPLE_RATE),
  finish: () => speechFinish(),
  cancel: () => speechCancel(),
  readPreference: () => loadDictationEnginePreference(),
  onText: (handler) => {
    addExpoTwoWayAudioEventListener('onSpeechText', handler)
  },
  onError: (handler) => {
    addExpoTwoWayAudioEventListener('onSpeechError', (event) => handler(event.code))
  }
}

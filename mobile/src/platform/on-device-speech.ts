import type { DictationTerm } from '../../../src/shared/dictation-dictionary'
import type { OnDeviceSpeech } from './on-device-speech-contract'

// The session screen is a page in the shell (on-device-speech.web.ts); native screens dictate through the computer.
export function useOnDeviceSpeech(
  _removeFillerWords?: boolean,
  _dictationTerms?: readonly DictationTerm[]
): OnDeviceSpeech | null {
  return null
}

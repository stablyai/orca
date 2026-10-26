import type { TextInput } from 'react-native'
import { hostOs } from '../platform/host-os'
import { createTerminalKeyChordInput } from './terminal-key-chord-input'
import { getTerminalLiveSpecialKeyId } from './terminal-live-input'
import type { TerminalLiveAccessoryInput } from './terminal-live-accessory-input'

// RN Web skips composing Enter keydowns; beforeinput line breaks recover those submits.
// Submitted keydowns are cancelled, preventing duplicates; candidate acceptance emits insertCompositionText and remains untouched.
export function bindTerminalTextFieldSubmit(
  node: TextInput | null,
  onSubmit: () => void,
  onKeyChord?: (input: TerminalLiveAccessoryInput) => boolean
): () => void {
  if (!(node instanceof HTMLInputElement) && !(node instanceof HTMLTextAreaElement)) {
    return () => {}
  }
  const field = node
  const submitOnLineBreak = (event: Event): void => {
    if (!(event instanceof InputEvent)) {
      return
    }
    if (event.inputType !== 'insertLineBreak' && event.inputType !== 'insertParagraph') {
      return
    }
    event.preventDefault()
    onSubmit()
  }
  const captureAndroidChords = hostOs() === 'android'
  let composing = false
  const startComposition = (): void => {
    composing = true
  }
  const endComposition = (): void => {
    composing = false
  }
  const captureKeyChord = (event: Event): void => {
    if (!(event instanceof KeyboardEvent)) {
      return
    }
    if (
      !captureAndroidChords ||
      !onKeyChord ||
      event.defaultPrevented ||
      composing ||
      event.isComposing ||
      event.keyCode === 229 ||
      event.metaKey ||
      event.getModifierState('AltGraph') ||
      (event.ctrlKey && event.altKey) ||
      (event.ctrlKey && event.key === ' ')
    ) {
      return
    }
    const specialKey = getTerminalLiveSpecialKeyId(event.key)
    if (
      event.key === 'Enter' ||
      event.key === 'Backspace' ||
      event.key === 'Delete' ||
      (!specialKey && !(event.key.length === 1 && (event.ctrlKey || event.altKey)))
    ) {
      return
    }
    const input = createTerminalKeyChordInput({
      key: specialKey ?? event.key,
      ctrl: event.ctrlKey,
      alt: event.altKey,
      shift: event.shiftKey
    })
    if (!input || !onKeyChord(input)) {
      return
    }
    event.preventDefault()
    event.stopPropagation()
  }
  field.addEventListener('beforeinput', submitOnLineBreak)
  field.addEventListener('compositionstart', startComposition)
  field.addEventListener('compositionend', endComposition)
  field.addEventListener('keydown', captureKeyChord, true)
  return () => {
    field.removeEventListener('beforeinput', submitOnLineBreak)
    field.removeEventListener('compositionstart', startComposition)
    field.removeEventListener('compositionend', endComposition)
    field.removeEventListener('keydown', captureKeyChord, true)
  }
}

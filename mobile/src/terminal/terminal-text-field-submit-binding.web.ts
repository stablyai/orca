import type { TextInput } from 'react-native'
import { hostOs } from '../platform/host-os'
import { createTerminalKeyChordInput } from './terminal-key-chord-input'
import { getTerminalLiveSpecialKeyId } from './terminal-live-input'
import type { TerminalLiveAccessoryInput } from './terminal-live-accessory-input'

/**
 * Claim the page's own submit signal for the live input, because react-native-web withholds
 * `onSubmitEditing` whenever the Enter keydown reports an open composition (`isComposing`, or the
 * Android `keyCode` 229 that stands for it) — the normal state of a soft keyboard mid-word.
 *
 * `beforeinput`/`insertLineBreak` is the browser saying the user asked to end the line, and it is
 * dispatched only when nothing cancelled the keydown. react-native-web calls `preventDefault` on
 * every keydown it does submit on, so this fires in exactly the cases it dropped, never twice. A
 * composing IME that is still choosing a candidate produces `insertCompositionText` instead and is
 * left alone, which is how an interrupted composition survives here as it does natively.
 */
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

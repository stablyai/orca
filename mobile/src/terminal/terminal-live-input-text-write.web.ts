import type { TextInputInstance } from 'react-native'
import type { RefObject } from 'react'

/**
 * RN Web renders a `TextInput` as an `<input>` or a `<textarea>`, and the ref is that node.
 * Checked rather than cast, so a release that wraps the field is left alone instead of missed.
 */
export function writeTerminalLiveInputText(
  ref: RefObject<TextInputInstance | null>,
  text: string
): void {
  const node = ref.current
  if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) {
    node.value = text
  }
}

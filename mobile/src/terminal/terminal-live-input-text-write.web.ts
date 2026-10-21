import type { RefObject } from 'react'
import type { TextInput } from 'react-native'

/**
 * RN Web renders a `TextInput` as an `<input>` or a `<textarea>`, and the ref is that node.
 * Checked rather than cast, so a release that wraps the field is left alone instead of missed.
 */
export function writeTerminalLiveInputText(ref: RefObject<TextInput | null>, text: string): void {
  const node = ref.current
  if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) {
    node.value = text
  }
}

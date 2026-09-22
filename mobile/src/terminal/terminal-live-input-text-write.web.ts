import type { RefObject } from 'react'
import type { TextInput } from 'react-native'

/**
 * Web sibling: on RN Web a `TextInput` ref is the DOM node itself, so `setNativeProps` does not
 * exist and the native write throws instead of landing.
 *
 * The node is checked rather than assumed. RN Web renders a single-line `TextInput` as an
 * `<input>` and a multiline one as a `<textarea>`, both of which carry `value`; anything else —
 * an unmounted ref, or a future release that wraps the field — is left alone rather than written
 * through a cast that would be wrong in the same way the native call was.
 */
export function writeTerminalLiveInputText(ref: RefObject<TextInput | null>, text: string): void {
  const node = ref.current
  if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) {
    node.value = text
  }
}

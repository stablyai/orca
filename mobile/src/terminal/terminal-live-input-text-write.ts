import type { RefObject } from 'react'
import type { TextInput } from 'react-native'

/**
 * Put text into the terminal's hidden live-input field without going through a render.
 *
 * The field is controlled, so React carries the same string on its next commit and this is not
 * what makes the text stick. What it covers is the gap before that commit, and the case where
 * React has no commit to make at all: a `value` prop that did not change leaves the field holding
 * whatever the platform's text system last put in it, which is exactly the state an interrupted
 * IME composition leaves behind.
 *
 * The `.web.ts` sibling exists because on React Native Web the ref is the DOM node itself and has
 * no `setNativeProps`, so this call is a `TypeError` rather than a write — and both callers reach
 * it from a mount effect, which faults the whole page.
 */
export function writeTerminalLiveInputText(ref: RefObject<TextInput | null>, text: string): void {
  ref.current?.setNativeProps({ text })
}

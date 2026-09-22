import type { RefObject } from 'react'
import type { TextInput } from 'react-native'

/**
 * The field is controlled, so this is for the case React has no commit to make: an unchanged
 * `value` prop leaves whatever an interrupted IME composition put there. The `.web.ts` sibling
 * exists because on RN Web the ref is the DOM node, where this call is a `TypeError`.
 */
export function writeTerminalLiveInputText(ref: RefObject<TextInput | null>, text: string): void {
  ref.current?.setNativeProps({ text })
}

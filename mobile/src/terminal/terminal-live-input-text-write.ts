import type { RefObject } from 'react'
import type { TextInput } from 'react-native'

// Unchanged controlled values need an imperative IME repair; RN Web refs are DOM nodes and require the platform sibling.
export function writeTerminalLiveInputText(ref: RefObject<TextInput | null>, text: string): void {
  ref.current?.setNativeProps({ text })
}

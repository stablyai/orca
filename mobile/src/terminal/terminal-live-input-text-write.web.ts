import type { RefObject } from 'react'
import type { TextInput } from 'react-native'

// RN Web refs are input/textarea nodes; reject future wrapper shapes before writing value.
export function writeTerminalLiveInputText(ref: RefObject<TextInput | null>, text: string): void {
  const node = ref.current
  if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) {
    node.value = text
  }
}

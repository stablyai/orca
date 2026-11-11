import type { RefObject } from 'react'
import type { TextInput } from 'react-native'
import type { TerminalLiveInputSelection } from './terminal-live-text-commit'

// RN Web refs are input/textarea nodes; reject future wrapper shapes before writing value.
export function writeTerminalLiveInputText(
  ref: RefObject<TextInput | null>,
  text: string,
  selection?: TerminalLiveInputSelection
): void {
  const node = ref.current
  if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) {
    node.value = text
    if (selection) {
      node.setSelectionRange(selection.start, selection.end)
    }
  }
}

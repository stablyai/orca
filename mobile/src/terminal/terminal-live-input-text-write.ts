import type { RefObject } from 'react'
import type { TextInput } from 'react-native'
import type { TerminalLiveInputSelection } from './terminal-live-text-commit'

// Unchanged controlled values need an imperative IME repair; RN Web refs are DOM nodes and require the platform sibling.
export function writeTerminalLiveInputText(
  ref: RefObject<TextInput | null>,
  text: string,
  selection?: TerminalLiveInputSelection
): void {
  ref.current?.setNativeProps({ text })
  if (selection) {
    // Fabric ignores collapsed selection props after replacing text.
    ref.current?.setSelection(selection.start, selection.end)
  }
}

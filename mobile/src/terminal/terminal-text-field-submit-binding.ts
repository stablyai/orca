import type { TextInput } from 'react-native'
import type { TerminalLiveAccessoryInput } from './terminal-live-accessory-input'

// Native editor actions submit during composition; the web platform sibling repairs RN Web’s missing submit signal.
export function bindTerminalTextFieldSubmit(
  _node: TextInput | null,
  _onSubmit: () => void,
  _onKeyChord?: (input: TerminalLiveAccessoryInput) => boolean
): () => void {
  return () => {}
}

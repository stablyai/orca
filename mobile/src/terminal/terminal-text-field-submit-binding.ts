import type { TextInput } from 'react-native'

/**
 * Native needs no binding: the editor action behind the return key fires `onSubmitEditing`
 * whatever the IME is doing. This exists to have a `.web.ts` sibling, where it does not.
 */
export function bindTerminalTextFieldSubmit(
  _node: TextInput | null,
  _onSubmit: () => void
): () => void {
  return () => {}
}

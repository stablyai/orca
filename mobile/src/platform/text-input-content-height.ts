import type { RefObject } from 'react'
import type { TextInput } from 'react-native'

// Native multiline inputs size themselves; the web sibling must measure textareas.
export function useTextInputContentHeight(
  _input: RefObject<TextInput | null>,
  _value: string
): number | undefined {
  return undefined
}

import type { RefObject } from 'react'
import type { TextInputInstance, TextStyle } from 'react-native'

// Native multiline inputs size themselves; the web sibling must measure textareas.
export function useTextInputContentHeight(
  _input: RefObject<TextInputInstance | null>,
  _value: string,
  _fontWeight?: TextStyle['fontWeight']
): number | undefined {
  return undefined
}

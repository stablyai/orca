import type { RefObject } from 'react'
import type { TextInputInstance } from 'react-native'

// Native multiline inputs size themselves; the web sibling must measure textareas.
export function useTextInputContentHeight(
  _input: RefObject<TextInputInstance | null>,
  _value: string
): number | undefined {
  return undefined
}

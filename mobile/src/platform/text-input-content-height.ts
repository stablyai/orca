import type { TextInputInstance } from 'react-native'
import type { RefObject } from 'react'

/** Native half of the seam: a multiline TextInput grows with its content between its own min and
 *  max heights, so there is nothing to measure. The web sibling measures, as a textarea does not. */
export function useTextInputContentHeight(
  _input: RefObject<TextInputInstance | null>,
  _value: string
): number | undefined {
  return undefined
}

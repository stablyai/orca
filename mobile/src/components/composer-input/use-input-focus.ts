import { useState } from 'react'
import type { TextInputProps } from 'react-native'

type FocusHandlers = Pick<TextInputProps, 'onFocus' | 'onBlur'>

/** Whether the field has focus, for its ring, still calling the caller's own handlers. */
export function useInputFocus({ onFocus, onBlur }: FocusHandlers): FocusHandlers & {
  focused: boolean
} {
  const [focused, setFocused] = useState(false)
  return {
    focused,
    onFocus: (event) => {
      setFocused(true)
      onFocus?.(event)
    },
    onBlur: (event) => {
      setFocused(false)
      onBlur?.(event)
    }
  }
}

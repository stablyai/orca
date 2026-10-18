import { useCallback, useEffect, useRef, useState } from 'react'
import { Keyboard, type TextInput } from 'react-native'

import { hostOs } from '../platform/host-os'

/**
 * Android command field: blur when the keyboard hides, and remount when the buffer
 * goes empty, so native selection handles cannot stick at the top-left.
 */
export function useMobileCommandInputField({
  bindCommandField,
  input
}: {
  bindCommandField: (node: TextInput | null) => void
  input: string
}): {
  commandFieldRef: (node: TextInput | null) => void
  emptyResetEpoch: number
  onCommandFieldFocus: () => void
  onCommandFieldBlur: () => void
} {
  const commandInputNodeRef = useRef<TextInput | null>(null)
  const isFocusedRef = useRef(false)
  const prevInputRef = useRef(input)
  const [emptyResetEpoch, setEmptyResetEpoch] = useState(0)

  const commandFieldRef = useCallback(
    (node: TextInput | null) => {
      commandInputNodeRef.current = node
      bindCommandField(node)
      if (node && isFocusedRef.current) {
        node.focus()
      }
    },
    [bindCommandField]
  )

  // Why: When user cancels/dismisses the Android soft keyboard, the native ReactEditText remains
  // focused. If selection handles or ActionMode were active, the displaced layout / empty text causes
  // Android PopupWindow to float to (0, 0) top-left corner. Blurring on keyboardDidHide forces
  // clearFocus() and completely dismisses all native handle popups.
  useEffect(() => {
    if (hostOs() !== 'android') {
      return
    }
    const sub = Keyboard.addListener('keyboardDidHide', () => {
      isFocusedRef.current = false
      commandInputNodeRef.current?.blur()
    })
    return () => sub.remove()
  }, [])

  // Why: On Android multiline, selecting text and clearing all input leaves Android's SelectionActionMode
  // and its dual teardrop handles active at (0, 0) because React Native's controlled setText("") does
  // not terminate native ActionMode. Cycling the key on transition to empty forces native ReactEditText
  // to unmount and detach from window, which invokes onDetachedFromWindow() -> stopTextActionMode()
  // and dismissHandleViews(), completely purging ghost handles.
  useEffect(() => {
    if (hostOs() === 'android') {
      if (prevInputRef.current && !input) {
        setEmptyResetEpoch((epoch) => epoch + 1)
      }
      prevInputRef.current = input
    }
  }, [input])

  return {
    commandFieldRef,
    emptyResetEpoch,
    onCommandFieldFocus: () => {
      isFocusedRef.current = true
    },
    onCommandFieldBlur: () => {
      isFocusedRef.current = false
    }
  }
}

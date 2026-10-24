import { useCallback, useEffect, useRef, useState } from 'react'
import type { TextInput } from 'react-native'

import { hostOs } from '../platform/host-os'
import { subscribeSoftKeyboard } from '../platform/keyboard-occlusion'

const MIN_COMMAND_INPUT_HEIGHT = 34
const MAX_COMMAND_INPUT_HEIGHT = 120

function clampCommandInputHeight(height: number): number {
  return Math.min(Math.max(height, MIN_COMMAND_INPUT_HEIGHT), MAX_COMMAND_INPUT_HEIGHT)
}

/** Web `<textarea>` defaults to 2 rows when `numberOfLines` is omitted. */
function measureWebTextareaHeight(node: unknown): number | undefined {
  if (typeof HTMLTextAreaElement === 'undefined' || !(node instanceof HTMLTextAreaElement)) {
    return undefined
  }
  node.rows = 1
  node.style.height = `${MIN_COMMAND_INPUT_HEIGHT}px`
  const measured = clampCommandInputHeight(node.scrollHeight)
  node.style.height = `${measured}px`
  return measured
}

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
  inputHeight: number
  onContentSizeChange: (e: { nativeEvent: { contentSize: { height: number } } }) => void
  onCommandFieldFocus: () => void
  onCommandFieldBlur: () => void
} {
  const commandInputNodeRef = useRef<TextInput | null>(null)
  const isFocusedRef = useRef(false)
  const prevInputRef = useRef(input)
  const [emptyResetEpoch, setEmptyResetEpoch] = useState(0)
  const [contentHeight, setContentHeight] = useState(MIN_COMMAND_INPUT_HEIGHT)

  const commandFieldRef = useCallback(
    (node: TextInput | null) => {
      commandInputNodeRef.current = node
      bindCommandField(node)
      if (typeof HTMLTextAreaElement !== 'undefined' && node instanceof HTMLTextAreaElement) {
        node.rows = 1
      }
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
    return subscribeSoftKeyboard(
      () => {},
      () => {
        isFocusedRef.current = false
        commandInputNodeRef.current?.blur()
      }
    )
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
    if (!input) {
      const node: unknown = commandInputNodeRef.current
      if (typeof HTMLTextAreaElement !== 'undefined' && node instanceof HTMLTextAreaElement) {
        node.rows = 1
        node.style.height = `${MIN_COMMAND_INPUT_HEIGHT}px`
      }
      setContentHeight(MIN_COMMAND_INPUT_HEIGHT)
      return
    }
    const measured = measureWebTextareaHeight(commandInputNodeRef.current)
    if (typeof measured === 'number') {
      setContentHeight(measured)
    }
  }, [input])

  const onContentSizeChange = useCallback(
    (e: { nativeEvent: { contentSize: { height: number } } }) => {
      const measured = measureWebTextareaHeight(commandInputNodeRef.current)
      if (typeof measured === 'number') {
        setContentHeight(measured)
        return
      }
      const height = e.nativeEvent?.contentSize?.height
      if (typeof height === 'number' && Number.isFinite(height)) {
        setContentHeight(clampCommandInputHeight(height))
      }
    },
    []
  )

  return {
    commandFieldRef,
    emptyResetEpoch,
    inputHeight: input ? contentHeight : MIN_COMMAND_INPUT_HEIGHT,
    onContentSizeChange,
    onCommandFieldFocus: () => {
      isFocusedRef.current = true
    },
    onCommandFieldBlur: () => {
      isFocusedRef.current = false
    }
  }
}

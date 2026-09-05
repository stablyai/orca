import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { Platform, type TextInput } from 'react-native'
import { isHardwareKeyboardConnected } from '@orca/expo-hardware-keyboard-navigation'

export function useHardwareKeyboardTextInputFocus(options: {
  enabled: boolean
  inputRef: RefObject<TextInput | null>
  surfaceId: string
}): {
  handleTouchStart: () => void
  showSoftInputOnFocus: boolean
} {
  const { enabled, inputRef, surfaceId } = options
  const [suppressSoftInput, setSuppressSoftInput] = useState(false)
  const touchFocusFrameRef = useRef<number | null>(null)

  useEffect(() => {
    if (!enabled || !isHardwareKeyboardConnected()) {
      setSuppressSoftInput(false)
      return
    }
    setSuppressSoftInput(true)
    let verifyTimer: ReturnType<typeof setTimeout> | null = null
    const frame = requestAnimationFrame(() => {
      const input = inputRef.current
      if (!input) {
        return
      }
      input.setNativeProps({ showSoftInputOnFocus: false })
      input.focus()
      verifyTimer = setTimeout(() => {
        if (!inputRef.current?.isFocused()) {
          inputRef.current?.setNativeProps({ showSoftInputOnFocus: false })
          inputRef.current?.focus()
        }
      }, 120)
    })
    return () => {
      cancelAnimationFrame(frame)
      if (verifyTimer !== null) {
        clearTimeout(verifyTimer)
      }
    }
  }, [enabled, inputRef, surfaceId])

  useEffect(
    () => () => {
      if (touchFocusFrameRef.current !== null) {
        cancelAnimationFrame(touchFocusFrameRef.current)
      }
    },
    []
  )

  const handleTouchStart = useCallback(() => {
    const input = inputRef.current
    if (Platform.OS !== 'android' || !suppressSoftInput || !input) {
      return
    }
    setSuppressSoftInput(false)
    input.setNativeProps({ showSoftInputOnFocus: true })
    input.blur()
    touchFocusFrameRef.current = requestAnimationFrame(() => {
      touchFocusFrameRef.current = null
      input.focus()
    })
  }, [inputRef, suppressSoftInput])

  return { handleTouchStart, showSoftInputOnFocus: !suppressSoftInput }
}

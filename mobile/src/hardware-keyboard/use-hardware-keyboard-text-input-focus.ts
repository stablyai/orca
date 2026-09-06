import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { AppState, Platform, type TextInput } from 'react-native'
import { useFocusEffect } from 'expo-router'
import {
  addHardwareKeyboardConnectionListener,
  isHardwareKeyboardConnected
} from '@orca/expo-hardware-keyboard-navigation'

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
  const cancelAutomaticFocusRef = useRef<(() => void) | null>(null)
  const [connected, setConnected] = useState(isHardwareKeyboardConnected)

  useEffect(() => {
    const connection = addHardwareKeyboardConnectionListener(({ connected }) =>
      setConnected(connected)
    )
    const appState = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        setConnected(isHardwareKeyboardConnected())
      }
    })
    setConnected(isHardwareKeyboardConnected())
    return () => {
      connection?.remove()
      appState.remove()
    }
  }, [])

  useFocusEffect(
    useCallback(() => {
      if (!enabled || !connected) {
        setSuppressSoftInput(false)
        inputRef.current?.setNativeProps({ showSoftInputOnFocus: true })
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
      const cancelAutomaticFocus = () => {
        cancelAnimationFrame(frame)
        if (verifyTimer !== null) {
          clearTimeout(verifyTimer)
          verifyTimer = null
        }
      }
      cancelAutomaticFocusRef.current = cancelAutomaticFocus
      return () => {
        cancelAutomaticFocus()
        cancelAutomaticFocusRef.current = null
        if (touchFocusFrameRef.current !== null) {
          cancelAnimationFrame(touchFocusFrameRef.current)
        }
        inputRef.current?.setNativeProps({ showSoftInputOnFocus: true })
      }
    }, [enabled, connected, inputRef, surfaceId])
  )

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
    if (!suppressSoftInput || !input) {
      return
    }
    // A touch request supersedes both phases of automatic hardware focus.
    cancelAutomaticFocusRef.current?.()
    setSuppressSoftInput(false)
    input.setNativeProps({ showSoftInputOnFocus: true })
    input.blur()
    touchFocusFrameRef.current = requestAnimationFrame(() => {
      touchFocusFrameRef.current = null
      // Android touch can reclaim focus before this frame, making RN focus() a no-op.
      if (Platform.OS === 'android' && input.isFocused()) {
        input.blur()
      }
      input.focus()
    })
  }, [inputRef, suppressSoftInput])

  return { handleTouchStart, showSoftInputOnFocus: !suppressSoftInput }
}

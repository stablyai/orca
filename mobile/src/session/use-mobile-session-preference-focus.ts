import { useCallback } from 'react'
import { useFocusEffect } from 'expo-router'
import type { MobileSessionKeyboardStateModel } from './use-mobile-session-keyboard-state'

export function useMobileSessionPreferenceFocus(scope: MobileSessionKeyboardStateModel) {
  const {
    setTerminalTextScale,
    setAutocompleteEnabled,
    setTerminalLinkOpenMode,
    sessionDeviceOperations
  } = scope
  // Reload after settings routes update native or paired-host page preferences.
  useFocusEffect(
    useCallback(() => {
      let active = true
      void sessionDeviceOperations
        ?.loadTerminalPreferences()
        .then((preferences) => {
          if (!active) {
            return
          }
          setTerminalTextScale(preferences.textScale)
          setAutocompleteEnabled(preferences.autocompleteEnabled)
          setTerminalLinkOpenMode(preferences.linkOpenMode)
        })
        .catch(() => {})
      return () => {
        active = false
      }
    }, [sessionDeviceOperations])
  )
}

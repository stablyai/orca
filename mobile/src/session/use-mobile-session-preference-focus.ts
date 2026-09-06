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
  // Why: phone-local terminal settings remain shell-owned in the hosted route.
  useFocusEffect(
    useCallback(() => {
      let active = true
      void sessionDeviceOperations?.loadTerminalPreferences().then((preferences) => {
        if (!active) {
          return
        }
        setTerminalTextScale(preferences.textScale)
        setAutocompleteEnabled(preferences.autocompleteEnabled)
        setTerminalLinkOpenMode(preferences.linkOpenMode)
      })
      return () => {
        active = false
      }
    }, [sessionDeviceOperations])
  )
}

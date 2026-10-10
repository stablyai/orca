import { useCallback } from 'react'
import { useFocusEffect } from 'expo-router'
import {
  loadTerminalAutocompleteEnabled,
  loadTerminalLinkOpenMode,
  loadTerminalTextScale
} from '../storage/preferences'
import type { MobileSessionKeyboardStateModel } from './use-mobile-session-keyboard-state'

export function useMobileSessionPreferenceFocus(scope: MobileSessionKeyboardStateModel) {
  const { setTerminalTextScale, setAutocompleteEnabled, setTerminalLinkOpenMode } = scope
  // Why: pick up Settings → Terminal text size on return; panes stay mounted and update in place.
  useFocusEffect(
    useCallback(() => {
      let active = true
      void loadTerminalTextScale().then((scale) => {
        if (active) {
          setTerminalTextScale(scale)
        }
      })
      return () => {
        active = false
      }
    }, [])
  )

  // Why: pick up the Settings → Terminal autocomplete toggle when returning here.
  useFocusEffect(
    useCallback(() => {
      let active = true
      void loadTerminalAutocompleteEnabled().then((enabled) => {
        if (active) {
          setAutocompleteEnabled(enabled)
        }
      })
      return () => {
        active = false
      }
    }, [])
  )

  // Why: link routing is a phone-local choice; reload after Settings → Browser.
  useFocusEffect(
    useCallback(() => {
      let active = true
      void loadTerminalLinkOpenMode().then((mode) => {
        if (active) {
          setTerminalLinkOpenMode(mode)
        }
      })
      return () => {
        active = false
      }
    }, [])
  )
}

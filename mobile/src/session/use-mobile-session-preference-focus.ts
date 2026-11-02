import { settleSessionPreferenceRead } from './session-preference-read'
import { useCallback, useState } from 'react'
import { useFocusEffect } from 'expo-router'
import { hostOs } from '../platform/host-os'
import {
  loadTerminalAutocompleteEnabled,
  loadTerminalKeyboardResizeEnabled,
  loadTerminalLinkOpenMode,
  loadTerminalTextScale
} from '../storage/preferences'
import type { MobileSessionKeyboardStateModel } from './use-mobile-session-keyboard-state'

export function useMobileSessionPreferenceFocus(
  scope: Pick<
    MobileSessionKeyboardStateModel,
    | 'setTerminalTextScale'
    | 'terminalTextScaleRevisionRef'
    | 'setAutocompleteEnabled'
    | 'setTerminalLinkOpenMode'
    | 'setTerminalKeyboardResizeEnabled'
  >
) {
  const {
    setTerminalTextScale,
    terminalTextScaleRevisionRef,
    setAutocompleteEnabled,
    setTerminalLinkOpenMode,
    setTerminalKeyboardResizeEnabled
  } = scope
  const [terminalPreferencesReady, setTerminalPreferencesReady] = useState(false)
  // Reload on Settings return without dropping readiness or remounting terminal panes.
  useFocusEffect(
    useCallback(() => {
      let active = true
      const scaleRevision = terminalTextScaleRevisionRef.current
      void settleSessionPreferenceRead(
        Promise.all([
          loadTerminalTextScale(),
          loadTerminalAutocompleteEnabled(),
          loadTerminalLinkOpenMode(),
          hostOs() === 'android' ? loadTerminalKeyboardResizeEnabled() : Promise.resolve(false)
        ])
      ).then((preferences) => {
        if (active) {
          if (preferences) {
            const [scale, autocomplete, linkMode, keyboardResize] = preferences
            if (terminalTextScaleRevisionRef.current === scaleRevision) {
              setTerminalTextScale(scale)
            }
            setAutocompleteEnabled(autocomplete)
            setTerminalLinkOpenMode(linkMode)
            setTerminalKeyboardResizeEnabled(keyboardResize)
          }
          setTerminalPreferencesReady(true)
        }
      })
      return () => {
        active = false
      }
    }, [])
  )
  return { terminalPreferencesReady }
}

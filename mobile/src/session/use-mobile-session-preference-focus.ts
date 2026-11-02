import { settleSessionPreferenceRead } from './session-preference-read'
import { useCallback, useState } from 'react'
import { useFocusEffect } from 'expo-router'
import {
  loadTerminalAutocompleteEnabled,
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
  >
) {
  const {
    setTerminalTextScale,
    terminalTextScaleRevisionRef,
    setAutocompleteEnabled,
    setTerminalLinkOpenMode
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
          loadTerminalLinkOpenMode()
        ])
      ).then((preferences) => {
        if (active) {
          if (preferences) {
            const [scale, autocomplete, linkMode] = preferences
            if (terminalTextScaleRevisionRef.current === scaleRevision) {
              setTerminalTextScale(scale)
            }
            setAutocompleteEnabled(autocomplete)
            setTerminalLinkOpenMode(linkMode)
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

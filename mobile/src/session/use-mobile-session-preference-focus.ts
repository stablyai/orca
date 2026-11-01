import { settleSessionPreferenceRead } from './session-preference-read'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useFocusEffect } from 'expo-router'
import { subscribeMirroredKey } from '../storage/mirrored-storage-keys'
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
  const readRevisionRef = useRef(0)

  const refreshTerminalPreferences = useCallback(() => {
    const revision = ++readRevisionRef.current
    const scaleRevision = terminalTextScaleRevisionRef.current
    void settleSessionPreferenceRead(
      Promise.all([
        loadTerminalTextScale(),
        loadTerminalAutocompleteEnabled(),
        loadTerminalLinkOpenMode()
      ])
    ).then((preferences) => {
      if (readRevisionRef.current !== revision) {
        return
      }
      if (preferences) {
        const [scale, autocomplete, linkMode] = preferences
        if (terminalTextScaleRevisionRef.current === scaleRevision) {
          setTerminalTextScale(scale)
        }
        setAutocompleteEnabled(autocomplete)
        setTerminalLinkOpenMode(linkMode)
      }
      setTerminalPreferencesReady(true)
    })
    return () => {
      if (readRevisionRef.current === revision) {
        readRevisionRef.current += 1
      }
    }
  }, [])

  // Reload on Settings return without dropping readiness or remounting terminal panes.
  useFocusEffect(refreshTerminalPreferences)

  useEffect(() => {
    const keys = [
      'orca:terminalTextScale',
      'orca:terminalAutocompleteEnabled',
      'orca:terminalLinkOpenMode'
    ]
    const unsubscribes = keys.map((key) =>
      subscribeMirroredKey(key, () => {
        refreshTerminalPreferences()
      })
    )
    return () => {
      readRevisionRef.current += 1
      for (const unsubscribe of unsubscribes) {
        unsubscribe()
      }
    }
  }, [refreshTerminalPreferences])

  return { terminalPreferencesReady }
}

import { useShellStorage } from '../platform/shell-storage'
import { settleSessionPreferenceRead } from './session-preference-read'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useFocusEffect } from 'expo-router'
import { subscribeMirroredKey } from '../storage/mirrored-storage-keys'
import { loadTerminalLinkOpenMode, loadTerminalTextScale } from '../storage/preferences'
import type { MobileSessionKeyboardStateModel } from './use-mobile-session-keyboard-state'

export function useMobileSessionPreferenceFocus(
  scope: Pick<
    MobileSessionKeyboardStateModel,
    'setTerminalTextScale' | 'terminalTextScaleRevisionRef' | 'setTerminalLinkOpenMode'
  >
) {
  const { setTerminalTextScale, terminalTextScaleRevisionRef, setTerminalLinkOpenMode } = scope
  const shellStorage = useShellStorage()
  const [terminalPreferencesReady, setTerminalPreferencesReady] = useState(false)
  const readRevisionRef = useRef(0)

  const refreshTerminalPreferences = useCallback(() => {
    const revision = ++readRevisionRef.current
    const scaleRevision = terminalTextScaleRevisionRef.current
    void settleSessionPreferenceRead(
      Promise.all([loadTerminalTextScale(), loadTerminalLinkOpenMode()])
    ).then((preferences) => {
      if (readRevisionRef.current !== revision) {
        return
      }
      if (preferences) {
        const [scale, linkMode] = preferences
        if (terminalTextScaleRevisionRef.current === scaleRevision) {
          setTerminalTextScale(scale)
        }
        setTerminalLinkOpenMode(linkMode)
      }
      setTerminalPreferencesReady(true)
    })
    return () => {
      if (readRevisionRef.current === revision) {
        readRevisionRef.current += 1
      }
    }
  }, [shellStorage])

  // Reload on Settings return without dropping readiness or remounting terminal panes.
  useFocusEffect(refreshTerminalPreferences)

  useEffect(() => {
    const keys = ['orca:terminalTextScale', 'orca:terminalLinkOpenMode']
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

import { useShellStorage } from '../platform/shell-storage/shell-storage'
import { settleSessionPreferenceRead } from './session-preference-read'
import { useCallback, useState } from 'react'
import { useFocusEffect } from 'expo-router'
import { loadTerminalLinkOpenMode, loadTerminalTextScale } from '../storage/preferences'
import type { MobileSessionKeyboardStateModel } from '../terminal/session/use-mobile-session-keyboard-state'

export function useMobileSessionPreferenceFocus(
  scope: Pick<
    MobileSessionKeyboardStateModel,
    'setTerminalTextScale' | 'terminalTextScaleRevisionRef' | 'setTerminalLinkOpenMode'
  >
) {
  const { setTerminalTextScale, terminalTextScaleRevisionRef, setTerminalLinkOpenMode } = scope
  const shellStorage = useShellStorage()
  const [terminalPreferencesReady, setTerminalPreferencesReady] = useState(false)
  // Reload on Settings return without dropping readiness or remounting terminal panes.
  useFocusEffect(
    useCallback(() => {
      let active = true
      const scaleRevision = terminalTextScaleRevisionRef.current
      void settleSessionPreferenceRead(
        Promise.all([loadTerminalTextScale(), loadTerminalLinkOpenMode()])
      ).then((preferences) => {
        if (active) {
          if (preferences) {
            const [scale, linkMode] = preferences
            if (terminalTextScaleRevisionRef.current === scaleRevision) {
              setTerminalTextScale(scale)
            }
            setTerminalLinkOpenMode(linkMode)
          }
          setTerminalPreferencesReady(true)
        }
      })
      return () => {
        active = false
      }
    }, [shellStorage])
  )
  return { terminalPreferencesReady }
}

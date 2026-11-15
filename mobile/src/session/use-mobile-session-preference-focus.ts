import { useShellStorage } from '../platform/shell-storage/shell-storage'
import { settleSessionPreferenceRead } from './session-preference-read'
import { useCallback, useState } from 'react'
import { useFocusEffect } from 'expo-router'
import { loadLinkOpenMode, loadTerminalTextScale } from '../storage/preferences'
import type { MobileSessionKeyboardStateModel } from '../terminal/session/input-controls/use-mobile-session-keyboard-state'

export function useMobileSessionPreferenceFocus(
  scope: Pick<
    MobileSessionKeyboardStateModel,
    'setTerminalTextScale' | 'terminalTextScaleRevisionRef' | 'setLinkOpenMode'
  >
) {
  const { setTerminalTextScale, terminalTextScaleRevisionRef, setLinkOpenMode } = scope
  const shellStorage = useShellStorage()
  const [terminalPreferencesReady, setTerminalPreferencesReady] = useState(false)
  // Reload on Settings return without dropping readiness or remounting terminal panes.
  useFocusEffect(
    useCallback(() => {
      let active = true
      const scaleRevision = terminalTextScaleRevisionRef.current
      void settleSessionPreferenceRead(
        Promise.all([loadTerminalTextScale(), loadLinkOpenMode()])
      ).then((preferences) => {
        if (active) {
          if (preferences) {
            const [scale, linkMode] = preferences
            if (terminalTextScaleRevisionRef.current === scaleRevision) {
              setTerminalTextScale(scale)
            }
            setLinkOpenMode(linkMode)
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

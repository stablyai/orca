import { useShellStorage } from '../platform/shell-storage/shell-storage'
import { settleSessionPreferenceRead } from './session-preference-read'
import { useCallback, useState } from 'react'
import { useFocusEffect } from 'expo-router'
import {
  loadLinkOpenMode,
  loadTerminalFontStyle,
  loadTerminalTextScale,
  saveTerminalFontStyle,
  saveTerminalTextScale
} from '../storage/preferences'
import {
  sameTerminalFontStyle,
  type TerminalFontStyle
} from '../terminal/preferences/terminal-font-style'
import { terminalFontDefaults } from '../terminal/preferences/terminal-font-defaults'
import type { MobileSessionKeyboardStateModel } from '../terminal/session/input-controls/use-mobile-session-keyboard-state'

export function useMobileSessionPreferenceFocus(
  scope: Pick<
    MobileSessionKeyboardStateModel,
    | 'setTerminalTextScale'
    | 'terminalTextScaleRevisionRef'
    | 'setTerminalFontStyle'
    | 'setLinkOpenMode'
  >
) {
  const {
    setTerminalTextScale,
    terminalTextScaleRevisionRef,
    setTerminalFontStyle,
    setLinkOpenMode
  } = scope
  const shellStorage = useShellStorage()
  const [terminalPreferencesReady, setTerminalPreferencesReady] = useState(false)
  // Reload on Settings return without dropping readiness or remounting terminal panes.
  useFocusEffect(
    useCallback(() => {
      let active = true
      const scaleRevision = terminalTextScaleRevisionRef.current
      const defaults = terminalFontDefaults()
      void settleSessionPreferenceRead(
        Promise.all([
          loadTerminalTextScale(defaults.textScale),
          loadLinkOpenMode(),
          loadTerminalFontStyle(defaults.fontStyle)
        ])
      ).then((preferences) => {
        if (active) {
          if (preferences) {
            const [scale, linkMode, fontStyle] = preferences
            if (terminalTextScaleRevisionRef.current === scaleRevision) {
              setTerminalTextScale(scale)
            }
            setTerminalFontStyle((current) =>
              sameTerminalFontStyle(current, fontStyle) ? current : fontStyle
            )
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
  // Pinch reports a whole-point size; persist it so it sticks across panes and launches and outranks a pending read.
  const commitPinchedTextScale = useCallback(
    (scale: number) => {
      terminalTextScaleRevisionRef.current += 1
      setTerminalTextScale(scale)
      void saveTerminalTextScale(scale)
    },
    [setTerminalTextScale, terminalTextScaleRevisionRef]
  )
  // The session's Text size sheet picks a font here, as Terminal settings does.
  const commitTerminalFontStyle = useCallback(
    (style: TerminalFontStyle) => {
      setTerminalFontStyle(style)
      void saveTerminalFontStyle(style)
    },
    [setTerminalFontStyle]
  )
  return { terminalPreferencesReady, commitPinchedTextScale, commitTerminalFontStyle }
}

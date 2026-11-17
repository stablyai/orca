import { useCallback, useEffect, useRef, useState } from 'react'
import {
  loadTerminalFontStyle,
  loadTerminalTextScale,
  saveTerminalFontStyle,
  saveTerminalTextScale
} from '../../storage/preferences'
import { terminalFontDefaults } from './terminal-font-defaults'
import type { TerminalFontStyle } from './terminal-font-style'

export type TerminalFontSettings = {
  textScale: number
  fontStyle: TerminalFontStyle
  /** Shows a size without saving it, e.g. while the slider is dragged. */
  previewTextScale: (scale: number) => void
  selectTextScale: (scale: number) => void
  selectFontStyle: (style: TerminalFontStyle) => void
  reset: () => void
}

// A selection made before the initial storage read resolves must win over that older read.
export function useTerminalFontSettings(): TerminalFontSettings {
  const [defaults] = useState(terminalFontDefaults)
  const [textScale, setTextScale] = useState(defaults.textScale)
  const [fontStyle, setFontStyle] = useState(defaults.fontStyle)
  const userSelectedScaleRef = useRef(false)
  const userSelectedStyleRef = useRef(false)
  useEffect(() => {
    let stale = false
    void Promise.all([
      loadTerminalTextScale(defaults.textScale),
      loadTerminalFontStyle(defaults.fontStyle)
    ]).then(([scale, style]) => {
      if (stale) {
        return
      }
      if (!userSelectedScaleRef.current) {
        setTextScale(scale)
      }
      if (!userSelectedStyleRef.current) {
        setFontStyle(style)
      }
    })
    return () => {
      stale = true
    }
  }, [defaults])
  const previewTextScale = useCallback((scale: number) => {
    userSelectedScaleRef.current = true
    setTextScale(scale)
  }, [])
  const selectTextScale = useCallback((scale: number) => {
    userSelectedScaleRef.current = true
    setTextScale(scale)
    void saveTerminalTextScale(scale)
  }, [])
  const selectFontStyle = useCallback((style: TerminalFontStyle) => {
    userSelectedStyleRef.current = true
    setFontStyle(style)
    void saveTerminalFontStyle(style)
  }, [])
  const reset = useCallback(() => {
    selectTextScale(defaults.textScale)
    selectFontStyle(defaults.fontStyle)
  }, [defaults, selectFontStyle, selectTextScale])
  return { textScale, fontStyle, previewTextScale, selectTextScale, selectFontStyle, reset }
}

import { useCallback, useRef, useState } from 'react'
import { useFocusEffect } from 'expo-router'
import { loadTerminalFont, readTerminalFontSource } from '../storage/terminal-font'
import type { TerminalCustomFont } from '../terminal/document/terminal-font'

/** The imported terminal font, re-read on focus so a Settings change applies to mounted panes. */
export function useTerminalFont(): TerminalCustomFont {
  const [font, setFont] = useState<TerminalCustomFont>(null)
  // Why: the file is the expensive read; skip it while the stored choice is unchanged.
  const loadedFileRef = useRef<string | null>(null)
  useFocusEffect(
    useCallback(() => {
      let active = true
      void (async () => {
        const preference = await loadTerminalFont()
        const fileName = preference?.fileName ?? null
        if (fileName === loadedFileRef.current) {
          return
        }
        const next = preference ? await readTerminalFontSource(preference) : null
        if (active) {
          loadedFileRef.current = fileName
          setFont(next)
        }
      })()
      return () => {
        active = false
      }
    }, [])
  )
  return font
}

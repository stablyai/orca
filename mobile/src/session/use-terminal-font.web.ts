import { useCallback, useRef, useState } from 'react'
import { useFocusEffect } from 'expo-router'
import { BRIDGE_TERMINAL_FONT_CHUNK_BYTES } from '../mobile-web-shell/bridge/bridge-native-verbs'
import { useNativeVerbs, type NativeVerbs } from '../mobile-web-shell/bridge/use-native-verbs'
import {
  TERMINAL_FONT_MIME_BY_EXTENSION,
  loadTerminalFont,
  terminalFontExtension,
  type TerminalFontPreference
} from '../storage/terminal-font-preference'
import type { TerminalCustomFont } from '../terminal/document/terminal-font'

/** The whole file as a data URL; each chunk is a multiple of three bytes, so the base64 joins. */
async function readFontThroughShell(
  verbs: NativeVerbs,
  font: TerminalFontPreference
): Promise<TerminalCustomFont> {
  const extension = terminalFontExtension(font.fileName)
  if (!extension) {
    return null
  }
  const parts: string[] = []
  let offset = 0
  let size = 1
  while (offset < size) {
    const chunk = await verbs.readTerminalFont(font.fileName, offset)
    size = chunk.size
    if (chunk.base64.length === 0) {
      break
    }
    parts.push(chunk.base64)
    offset += BRIDGE_TERMINAL_FONT_CHUNK_BYTES
  }
  return parts.length
    ? { source: `data:${TERMINAL_FONT_MIME_BY_EXTENSION[extension]};base64,${parts.join('')}` }
    : null
}

/** Web sibling: the page reads the choice from its store and the file through the shell. */
export function useTerminalFont(): TerminalCustomFont {
  const verbs = useNativeVerbs()
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
        let next: TerminalCustomFont = null
        if (preference && verbs.canReadTerminalFont) {
          try {
            next = await readFontThroughShell(verbs, preference)
          } catch (error) {
            console.warn('[terminal-font] the shell did not hand over the imported font', error)
            next = null
          }
        }
        if (active) {
          loadedFileRef.current = fileName
          setFont(next)
        }
      })()
      return () => {
        active = false
      }
    }, [verbs])
  )
  return font
}

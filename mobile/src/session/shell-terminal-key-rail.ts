import type {
  BridgeTerminalToolbar,
  BridgeTerminalKeyId,
  BridgeTerminalKeyRail
} from '../mobile-web-shell/bridge/bridge-terminal-key'
import { createElement, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useFocusEffect } from 'expo-router'
import { useSideRailContent, useSideRailStrip } from '../layout/side-rail'
import { TerminalKeyRail, terminalKeyRailKeys } from '../mobile-web-shell/terminal-key-rail'

const NO_RAIL_KEYS: BridgeTerminalKeyRail = []

/**
 * The keys the shell's rail shows beside this screen, which then drops them from its own row;
 * `onKey` takes each press on it. Native sessions claim the same root rail directly.
 */
export function useShellTerminalKeyRail(
  shown: boolean,
  onKey: (key: BridgeTerminalKeyId) => void,
  focusedTerminal?: string | null,
  toolbar?: BridgeTerminalToolbar
): BridgeTerminalKeyRail {
  const strip = useSideRailStrip()
  const [focused, setFocused] = useState(false)
  useFocusEffect(
    useCallback(() => {
      setFocused(true)
      return () => setFocused(false)
    }, [])
  )
  const height = strip?.height ?? 0
  const keys = useMemo(
    () => (shown && focused && height > 0 ? terminalKeyRailKeys(height, toolbar) : NO_RAIL_KEYS),
    [shown, focused, height, toolbar]
  )
  const inputRef = useRef({ onKey, focusedTerminal })
  useLayoutEffect(() => {
    inputRef.current = { onKey, focusedTerminal }
  }, [onKey, focusedTerminal])
  const node = useMemo(
    () =>
      keys.length
        ? createElement(TerminalKeyRail, {
            inputOwner: focusedTerminal,
            keys,
            toolbar,
            onKey: (key) => {
              if (inputRef.current.focusedTerminal !== focusedTerminal) {
                return false
              }
              inputRef.current.onKey(key)
              return true
            }
          })
        : null,
    [keys, focusedTerminal, toolbar]
  )
  useSideRailContent(node)
  return keys
}

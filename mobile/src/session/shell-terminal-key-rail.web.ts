import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useFocusEffect } from 'expo-router'
import type {
  BridgeTerminalKeyId,
  BridgeTerminalKeyRail
} from '../mobile-web-shell/bridge/bridge-terminal-key'
import { usePageBridgeClient } from '../transport/client-context.web'

const NO_RAIL_KEYS: BridgeTerminalKeyRail = []

/**
 * The keys the shell's rail shows beside this page, which then drops them from its own row; `onKey`
 * takes each press on it. Claimed only while `shown`, the terminal and its key row being on screen:
 * the shell draws the rail for a granted page, on a window with a side strip, while it holds one.
 */
export function useShellTerminalKeyRail(
  shown: boolean,
  onKey: (key: BridgeTerminalKeyId) => void
): BridgeTerminalKeyRail {
  const client = usePageBridgeClient()
  const keys = useSyncExternalStore(
    client.onTerminalKeyRailUpdate,
    () => client.getShellSession()?.terminalKeyRail ?? NO_RAIL_KEYS
  )
  // The page's own stack keeps the session mounted under a screen pushed over it, as Files is.
  const [focused, setFocused] = useState(false)
  useFocusEffect(
    useCallback(() => {
      setFocused(true)
      return () => setFocused(false)
    }, [])
  )
  const claiming = shown && focused
  const onKeyRef = useRef(onKey)
  onKeyRef.current = onKey
  useEffect(
    () => (claiming ? client.claimTerminalKeyRail((key) => onKeyRef.current(key)) : undefined),
    [client, claiming]
  )
  return claiming ? keys : NO_RAIL_KEYS
}

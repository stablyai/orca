import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore
} from 'react'
import { useFocusEffect } from 'expo-router'
import type {
  BridgeTerminalToolbar,
  BridgeTerminalKeyId,
  BridgeTerminalKeyRail
} from '../mobile-web-shell/bridge/bridge-terminal-key'
import { usePageBridgeClient } from '../transport/client-context.web'

let nextInputOwner = 0

const NO_RAIL_KEYS: BridgeTerminalKeyRail = []

/**
 * The keys the shell's rail shows beside this page, which then drops them from its own row; `onKey`
 * takes each press on it. Claimed only while `shown`, the terminal and its key row being on screen:
 * the shell draws the rail for a granted page, on a window with a side strip, while it holds one.
 */
export function useShellTerminalKeyRail(
  shown: boolean,
  onKey: (key: BridgeTerminalKeyId) => void,
  focusedTerminal?: string | null,
  toolbar?: BridgeTerminalToolbar
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
  const inputOwner = useMemo(() => `rail-${++nextInputOwner}`, [focusedTerminal, claiming])
  const ownerRef = useRef(inputOwner)
  const onKeyRef = useRef(onKey)
  const toolbarRef = useRef(toolbar)
  const claimRef = useRef<ReturnType<typeof client.claimTerminalKeyRail> | null>(null)
  useLayoutEffect(() => {
    ownerRef.current = inputOwner
    onKeyRef.current = onKey
    toolbarRef.current = toolbar
  }, [inputOwner, onKey, toolbar])
  useLayoutEffect(() => {
    if (!claiming) {
      return
    }
    const claim = client.claimTerminalKeyRail(
      (key, receivedOwner) => {
        if (ownerRef.current === receivedOwner) {
          onKeyRef.current(key)
        }
      },
      ownerRef.current,
      toolbarRef.current
    )
    claimRef.current = claim
    return () => {
      claimRef.current = null
      claim()
    }
  }, [client, claiming])
  useLayoutEffect(() => {
    claimRef.current?.update(inputOwner, toolbar)
  }, [inputOwner, toolbar])
  return claiming ? keys : NO_RAIL_KEYS
}

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useFocusEffect } from 'expo-router'
import { useSideRailContent, useSideRailStrip } from '../layout/side-rail'
import {
  sameTerminalKeyRailToolbar,
  BRIDGE_TERMINAL_KEY_RAIL_GRANT,
  type BridgeTerminalToolbar,
  type BridgeTerminalKeyId,
  type BridgeTerminalKeyRail
} from './bridge/bridge-terminal-key'
import { TerminalKeyRail, terminalKeyRailKeys } from './terminal-key-rail'

const NO_RAIL_KEYS: BridgeTerminalKeyRail = []

/**
 * The keys this shell screen's scrollable rail shows: when the window has one, the
 * page is open on the focused screen, was granted the rail, which only a session route is, and
 * claims it, which it does only while a terminal and its key row are on screen. Empty otherwise.
 */
export function useShellKeyRail(args: {
  /** The session on screen, or null while none is ready. A claim belongs to the one that made it. */
  sessionId: string | null
  overlay: boolean
  routeGrants: readonly string[]
}): {
  keys: BridgeTerminalKeyRail
  inputOwner: string | undefined
  toolbar: BridgeTerminalToolbar | undefined
  reportClaim: (claimed: boolean, inputOwner?: string, toolbar?: BridgeTerminalToolbar) => void
} {
  const { sessionId } = args
  const height = useSideRailStrip()?.height ?? null
  const [claim, setClaim] = useState<{
    sessionId: string | null
    inputOwner?: string
    toolbar?: BridgeTerminalToolbar
  } | null>(null)
  // Focus rather than mount: the stack keeps this screen mounted under whatever is pushed over it.
  const [focused, setFocused] = useState(false)
  useFocusEffect(
    useCallback(() => {
      setFocused(true)
      return () => setFocused(false)
    }, [])
  )
  const took =
    sessionId !== null &&
    claim?.sessionId === sessionId &&
    focused &&
    !args.overlay &&
    args.routeGrants.includes(BRIDGE_TERMINAL_KEY_RAIL_GRANT)
  const keys = useMemo(
    () => (took && height !== null ? terminalKeyRailKeys(height, claim?.toolbar) : NO_RAIL_KEYS),
    [took, height, claim?.toolbar]
  )
  const reportClaim = useCallback(
    (claimed: boolean, inputOwner?: string, toolbar?: BridgeTerminalToolbar) =>
      setClaim((previous) => {
        if (!claimed) {
          return null
        }
        // Equivalent init reassertions must not cancel a key already held on the rail.
        return previous?.sessionId === sessionId &&
          previous.inputOwner === inputOwner &&
          sameTerminalKeyRailToolbar(previous.toolbar, toolbar)
          ? previous
          : { sessionId, inputOwner, toolbar }
      }),
    [sessionId]
  )
  return { keys, inputOwner: claim?.inputOwner, toolbar: claim?.toolbar, reportClaim }
}

/** Draws the rail and tells the page which keys it holds, so the page drops just those. */
export function usePublishedShellKeyRail(
  keys: BridgeTerminalKeyRail,
  bridge: {
    publishTerminalKeyRail: (keys: BridgeTerminalKeyRail) => void
    sendTerminalKey: (key: BridgeTerminalKeyId, inputOwner?: string) => boolean
  },
  inputOwner?: string,
  toolbar?: BridgeTerminalToolbar
): void {
  const { publishTerminalKeyRail } = bridge
  useEffect(() => {
    publishTerminalKeyRail(keys)
  }, [publishTerminalKeyRail, keys])
  // Held, so a new bridge identity does not rebuild the node, which would show the rail again.
  const sendRef = useRef(bridge.sendTerminalKey)
  useLayoutEffect(() => {
    sendRef.current = bridge.sendTerminalKey
  }, [bridge.sendTerminalKey])
  const node = useMemo(
    () =>
      keys.length > 0 ? (
        <TerminalKeyRail
          inputOwner={inputOwner}
          keys={keys}
          toolbar={toolbar}
          onKey={(key) => sendRef.current(key, inputOwner)}
        />
      ) : null,
    [keys, inputOwner, toolbar]
  )
  useSideRailContent(node)
}

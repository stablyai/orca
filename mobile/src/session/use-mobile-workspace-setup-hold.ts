import { useCallback, useLayoutEffect, useRef, useSyncExternalStore } from 'react'
import type { RpcClient } from '../transport/rpc-client'
import { mobileStructuredSessionStatusFeed } from './mobile-structured-session-status-feed'

export function useMobileWorkspaceSetupHold(
  _hostId: string,
  worktreeId: string,
  connected: boolean,
  client: RpcClient | null
) {
  const feed = connected && client ? mobileStructuredSessionStatusFeed(client) : null
  const subscribe = useCallback(
    (listener: () => void) => (feed ? feed.subscribe(listener) : () => {}),
    [feed]
  )
  const readObservation = useCallback(
    () => (feed ? feed.isWorkspaceSetupHeld(worktreeId) : false),
    [feed, worktreeId]
  )
  const readSetupAgentStartHeld = useCallback(() => readObservation() !== false, [readObservation])
  const current = useRef(readSetupAgentStartHeld)
  // Publish only committed readers, so a retained Send or transcript reads the current workspace.
  useLayoutEffect(() => {
    current.current = readSetupAgentStartHeld
  }, [readSetupAgentStartHeld])
  const readCurrent = useCallback(() => current.current(), [])
  const observed = useSyncExternalStore(subscribe, readObservation, readObservation)
  return {
    setupAgentStartHeld: observed === true,
    setupInputHeld: observed !== false,
    readSetupAgentStartHeld: readCurrent
  }
}

import { useEffect, useRef } from 'react'
import type { MobileSessionAttachmentsModel } from './use-mobile-session-attachments'

/** Captures the committed screen that owns an in-flight terminal create. */
export function useMobileTerminalCreateRouteOwner(
  scope: Pick<
    MobileSessionAttachmentsModel,
    'hostId' | 'worktreeId' | 'client' | 'sessionTabsRef' | 'creatingTerminalRef' | 'setCreating'
  >
) {
  const { hostId, worktreeId, client, sessionTabsRef, creatingTerminalRef, setCreating } = scope
  const activationRef = useRef<symbol | null>(null)
  useEffect(() => {
    const activation = Symbol('session-create-route')
    activationRef.current = activation
    return () => {
      if (activationRef.current === activation) {
        activationRef.current = null
        creatingTerminalRef.current = null
        setCreating(false)
      }
    }
  }, [hostId, worktreeId, client, creatingTerminalRef, setCreating])

  return (sourceSessionId?: string) => {
    const activation = activationRef.current
    const isRouteCurrent = () => activation !== null && activationRef.current === activation
    const isCurrent = () =>
      isRouteCurrent() &&
      (!sourceSessionId ||
        sessionTabsRef.current.some(
          (tab) => tab.type === 'agent-session' && tab.sessionId === sourceSessionId
        ))
    return { isRouteCurrent, isCurrent }
  }
}

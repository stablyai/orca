import { useEffect, useRef } from 'react'
import type { MobileSessionAttachmentsModel } from '../../../files/attachments/use-mobile-session-attachments'
import { resolveMobileNativeChatSessionId } from '../../../session/native-chat/conversation/mobile-native-chat-eligibility'

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
      // A fork's source chat is still open: a chat session, or a terminal chat showing that session.
      (!sourceSessionId ||
        sessionTabsRef.current.some(
          (tab) => resolveMobileNativeChatSessionId(tab) === sourceSessionId
        ))
    return { isRouteCurrent, isCurrent }
  }
}

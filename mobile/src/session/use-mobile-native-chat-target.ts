import { useEffect, useMemo, useRef } from 'react'
import type { HostSessionNativeChatTarget } from './host-session-native-chat-operations'

export function useMobileNativeChatTarget(args: {
  workspaceId: string
  agent: string | null
  sessionId: string | null
  transcriptPath: string | null
  terminalId: string | null
  clientId: string | null
}) {
  const target = useMemo<HostSessionNativeChatTarget | null>(
    () =>
      args.agent && args.sessionId
        ? {
            workspaceId: args.workspaceId,
            agent: args.agent,
            sessionId: args.sessionId,
            transcriptPath: args.transcriptPath,
            terminalId: args.terminalId,
            clientId: args.clientId
          }
        : null,
    [
      args.agent,
      args.clientId,
      args.sessionId,
      args.terminalId,
      args.transcriptPath,
      args.workspaceId
    ]
  )
  const targetRef = useRef(target)
  useEffect(() => {
    targetRef.current = target
  }, [target])
  return { target, targetRef }
}

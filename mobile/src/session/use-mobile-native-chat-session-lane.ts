import { useCallback } from 'react'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'
import type { StructuredAgentSessionHostSupport } from './mobile-structured-agent-session-host-support'
import { useMobileNativeChatSession } from './use-mobile-native-chat-session'
import { useMobileStructuredAgentSession } from './use-mobile-structured-agent-session'
import type { MobileNativeChatSendErrorReporter } from './native-chat/use-mobile-native-chat-send-error'

// Run both hooks in fixed order and starve the inactive lane’s identity so flips preserve cached transcripts.
export function useMobileNativeChatSessionLane({
  client,
  structured,
  agent,
  resolvedAgent,
  transcriptPath,
  sessionId,
  sourceIdentity,
  hostSupport,
  appendComposerTextRef,
  enabled,
  connState,
  onSendError,
  onActionResolved
}: {
  client: RpcClient | null
  structured: boolean
  agent: string | null
  resolvedAgent: string | null
  transcriptPath: string | null
  sessionId: string | null
  sourceIdentity: Parameters<typeof useMobileNativeChatSession>[0]['sourceIdentity']
  hostSupport: StructuredAgentSessionHostSupport | null
  // Defer Edit through the composer ref because drafts mount after this lane.
  appendComposerTextRef: { readonly current: (text: string) => boolean }
  enabled: boolean
  connState: ConnectionState
  onSendError: MobileNativeChatSendErrorReporter
  onActionResolved?: () => void
}): {
  structuredSession: ReturnType<typeof useMobileStructuredAgentSession>
  session: ReturnType<typeof useMobileNativeChatSession>
} {
  const appendComposerText = useCallback(
    (text: string) => appendComposerTextRef.current(text),
    [appendComposerTextRef]
  )
  const bridgeSession = useMobileNativeChatSession({
    client,
    sourceIdentity,
    agent: structured ? null : resolvedAgent,
    sessionId: structured ? null : sessionId,
    transcriptPath: structured ? null : transcriptPath
  })
  const structuredSession = useMobileStructuredAgentSession({
    client,
    sessionId: structured ? sessionId : null,
    sourceIdentity,
    hostSupport,
    appendComposerText,
    enabled,
    // Holds are connection-scoped; dropping this on transport loss lets the hook
    // reacquire the provider without clearing the cached transcript.
    connected: connState === 'connected',
    agent: structured ? agent : null,
    onSendError,
    ...(onActionResolved ? { onActionResolved } : {})
  })
  return {
    structuredSession,
    session: structured ? structuredSession.session : bridgeSession
  }
}

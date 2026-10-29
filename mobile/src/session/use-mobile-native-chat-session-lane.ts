import { useCallback } from 'react'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'
import type { StructuredAgentSessionHostSupport } from './mobile-structured-agent-session-host-support'
import { useMobileNativeChatSession } from './use-mobile-native-chat-session'
import { useMobileStructuredAgentSession } from './use-mobile-structured-agent-session'
import { useMobileStructuredSessionCommands } from './use-mobile-structured-session-commands'
import type { MobileNativeChatResolution } from './native-chat/mobile-native-chat-eligibility'
import type { MobileNativeChatSendErrorReporter } from './native-chat/use-mobile-native-chat-send-error'

// Run both hooks in fixed order and starve the inactive lane’s identity so flips preserve cached transcripts.
export function useMobileNativeChatSessionLane({
  client,
  hostId,
  composerScopeKey,
  structured,
  resolution,
  sourceIdentity,
  hostSupport,
  appendComposerTextRef,
  enabled,
  connState,
  onSendError,
  onQueuedEditNotice,
  onActionResolved
}: {
  client: RpcClient | null
  hostId: string
  composerScopeKey?: string | null
  structured: boolean
  resolution: MobileNativeChatResolution | null
  sourceIdentity: Parameters<typeof useMobileNativeChatSession>[0]['sourceIdentity']
  hostSupport: StructuredAgentSessionHostSupport | null
  // Defer Edit through the composer ref because drafts mount after this lane.
  appendComposerTextRef: { readonly current: (text: string) => boolean }
  enabled: boolean
  connState: ConnectionState
  onQueuedEditNotice?: (message: string) => void
  onSendError: MobileNativeChatSendErrorReporter
  onActionResolved?: () => void
}): {
  structuredSession: ReturnType<typeof useMobileStructuredAgentSession>
  session: ReturnType<typeof useMobileNativeChatSession>
  sessionCommands: ReturnType<typeof useMobileStructuredSessionCommands>
} {
  const appendComposerText = useCallback(
    (text: string) => appendComposerTextRef.current(text),
    [appendComposerTextRef]
  )
  const agent = resolution?.agent ?? null
  const sessionId = resolution?.sessionId ?? null
  // One read serves both send-side ownership and the composer's `/` menu.
  const sessionCommands = useMobileStructuredSessionCommands({
    client,
    hostId,
    sessionId: structured ? sessionId : null,
    enabled: connState === 'connected'
  })
  const bridgeSession = useMobileNativeChatSession({
    client,
    sourceIdentity,
    agent: structured ? null : agent,
    sessionId: structured ? null : sessionId,
    transcriptPath: structured ? null : (resolution?.transcriptPath ?? null)
  })
  const structuredSession = useMobileStructuredAgentSession({
    client,
    sessionId: structured ? sessionId : null,
    sourceIdentity,
    hostSupport,
    appendComposerText,
    composerScopeKey,
    enabled,
    // Holds are connection-scoped; dropping this on transport loss lets the hook
    // reacquire the provider without clearing the cached transcript.
    connected: connState === 'connected',
    agent: structured ? agent : null,
    sessionCommands: sessionCommands.commands,
    onSendError,
    onQueuedEditNotice,
    ...(onActionResolved ? { onActionResolved } : {})
  })
  return {
    structuredSession,
    session: structured ? structuredSession.session : bridgeSession,
    sessionCommands
  }
}

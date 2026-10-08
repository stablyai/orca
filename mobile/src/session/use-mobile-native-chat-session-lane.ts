import { useCallback } from 'react'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'
import type { StructuredAgentSessionHostSupport } from './mobile-structured-agent-session-host-support'
import { useMobileNativeChatSession } from './use-mobile-native-chat-session'
import { useMobileStructuredAgentSession } from './use-mobile-structured-agent-session'

/** Mounts both transcript sources and hands back the one this tab's lane owns.
 *  Both hooks always run (hook order is fixed); the inactive lane is starved of
 *  its identity inputs rather than unmounted, so a lane flip keeps its cache. */
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
  /** Agent id for the structured provider session. */
  agent: string | null
  /** Agent resolved from the terminal, for the bridge transcript reader. */
  resolvedAgent: string | null
  transcriptPath: string | null
  sessionId: string | null
  sourceIdentity: Parameters<typeof useMobileNativeChatSession>[0]['sourceIdentity']
  hostSupport: StructuredAgentSessionHostSupport | null
  /** The active pane's live composer; a queued card's Edit copies through it.
   *  A ref because the drafts (and their append) mount after this lane. */
  appendComposerTextRef: { readonly current: (text: string) => boolean }
  enabled: boolean
  connState: ConnectionState
  onSendError: (message: string) => void
  /** Called on any accepted queued-card action; retires the route's failure banner. */
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

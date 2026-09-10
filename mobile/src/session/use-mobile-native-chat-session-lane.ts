import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'
import type { HostSessionNativeChatOperations } from './host-session-native-chat-operations'
import { useMobileNativeChatSession } from './use-mobile-native-chat-session'
import { useMobileStructuredAgentSession } from './use-mobile-structured-agent-session'

/** Mounts both transcript sources and hands back the one this tab's lane owns.
 *  Both hooks always run (hook order is fixed); the inactive lane is starved of
 *  its identity inputs rather than unmounted, so a lane flip keeps its cache. */
export function useMobileNativeChatSessionLane({
  client,
  nativeChatOperations,
  workspaceId,
  structured,
  agent,
  resolvedAgent,
  transcriptPath,
  sessionId,
  sourceIdentity,
  enabled,
  connState,
  onSendError
}: {
  client: RpcClient | null
  nativeChatOperations: HostSessionNativeChatOperations | null
  workspaceId: string
  structured: boolean
  /** Agent id for the structured provider session. */
  agent: string | null
  /** Agent resolved from the terminal, for the bridge transcript reader. */
  resolvedAgent: string | null
  transcriptPath: string | null
  sessionId: string | null
  sourceIdentity: Parameters<typeof useMobileNativeChatSession>[0]['sourceIdentity']
  enabled: boolean
  connState: ConnectionState
  onSendError: (message: string) => void
}): {
  structuredSession: ReturnType<typeof useMobileStructuredAgentSession>
  session: ReturnType<typeof useMobileNativeChatSession>
} {
  const bridgeSession = useMobileNativeChatSession({
    operations: nativeChatOperations,
    workspaceId,
    sourceIdentity,
    agent: structured ? null : resolvedAgent,
    sessionId: structured ? null : sessionId,
    transcriptPath: structured ? null : transcriptPath
  })
  const structuredSession = useMobileStructuredAgentSession({
    client,
    sessionId: structured ? sessionId : null,
    sourceIdentity,
    enabled,
    // Holds are connection-scoped; dropping this on transport loss lets the hook
    // reacquire the provider without clearing the cached transcript.
    connected: connState === 'connected',
    agent: structured ? agent : null,
    onSendError
  })
  return {
    structuredSession,
    session: structured ? structuredSession.session : bridgeSession
  }
}

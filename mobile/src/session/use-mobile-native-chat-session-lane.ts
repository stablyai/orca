import type { RpcClient } from '../transport/rpc-client'
import type { HostSessionNativeChatOperations } from './host-session-native-chat-operations'
import { useMobileNativeChatSession } from './use-mobile-native-chat-session'
import { useMobileStructuredAgentSession } from './use-mobile-structured-agent-session'

/** Mounts both transcript sources and hands back the one this tab's lane owns.
 *  Both hooks always run (hook order is fixed); the inactive lane is starved of
 *  its identity inputs rather than unmounted, so a lane flip keeps its cache. */
export function useMobileNativeChatSessionLane({
  operations,
  client,
  workspaceId,
  structured,
  agent,
  resolvedAgent,
  transcriptPath,
  sessionId,
  terminalId,
  clientId,
  sourceIdentity,
  enabled,
  connected,
  onSendError
}: {
  /** Bridge lane transport; the hosted page routes it through the shell. */
  operations: HostSessionNativeChatOperations | null
  /** Structured lane speaks the agent-session RPC family directly. */
  client: RpcClient | null
  workspaceId: string
  structured: boolean
  /** Agent id for the structured provider session. */
  agent: string | null
  /** Agent resolved from the terminal, for the bridge transcript reader. */
  resolvedAgent: string | null
  transcriptPath: string | null
  sessionId: string | null
  terminalId: string | null
  clientId: string | null
  sourceIdentity: Parameters<typeof useMobileStructuredAgentSession>[0]['sourceIdentity']
  enabled: boolean
  /** Live transport only; gates the connection-scoped structured hold. */
  connected: boolean
  onSendError: (message: string) => void
}): {
  structuredSession: ReturnType<typeof useMobileStructuredAgentSession>
  session: ReturnType<typeof useMobileNativeChatSession>
} {
  const bridgeSession = useMobileNativeChatSession({
    operations,
    workspaceId,
    agent: structured ? null : resolvedAgent,
    sessionId: structured ? null : sessionId,
    transcriptPath: structured ? null : transcriptPath,
    terminalId,
    clientId
  })
  const structuredSession = useMobileStructuredAgentSession({
    client,
    sessionId: structured ? sessionId : null,
    sourceIdentity,
    enabled,
    // Holds are connection-scoped; dropping this on transport loss lets the hook
    // reacquire the provider without clearing the cached transcript.
    connected,
    agent: structured ? agent : null,
    onSendError
  })
  return {
    structuredSession,
    session: structured ? structuredSession.session : bridgeSession
  }
}

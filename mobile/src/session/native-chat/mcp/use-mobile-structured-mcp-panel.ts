import { useCallback, useMemo, useState } from 'react'
import type {
  AgentSessionMcpOperation,
  AgentSessionMcpResult
} from '../../../../../src/shared/agent-session/agent-session-mcp'
import { AGENT_SESSION_MCP_RUNTIME_CAPABILITY } from '../../../../../src/shared/agent-session/agent-session-runtime-capabilities'
import type { StructuredAgentSessionComposerOptions } from '../../../../../src/shared/agent-session/view/structured-agent-session-composer'
import type { AgentSessionMcpRequest } from '../../../../../src/shared/agent-session/view/use-agent-session-mcp-panel'
import { useRouteRelaysCapability } from '../../../worktree/workspace-server-context'
import type { MobileStructuredAgentSessionArgs } from '../agent-session/mobile-structured-agent-session-contract'
import { callAgentSession } from '../agent-session/mobile-structured-agent-session-rpc'
import { useMobileRegisteredAgent } from '../agent-session/use-mobile-registered-agent'

// A cold Codex read or a Claude sign-in finish (exchange, reconnect, re-read) can run long.
const MCP_TIMEOUT_MS = 90_000

export type MobileStructuredMcpPanel = {
  open: boolean
  close: () => void
  request: AgentSessionMcpRequest
}

type McpCommands = Pick<StructuredAgentSessionComposerOptions, 'openMcpPanel'>

/** The chat's `/mcp` sheet, offered where the host manages this agent's MCP servers. */
export function useMobileStructuredMcpPanel<TCommands extends object>(
  session: Pick<
    MobileStructuredAgentSessionArgs,
    'client' | 'sessionId' | 'agent' | 'hostSupport' | 'enabled'
  >,
  sessionKey: string,
  commands: TCommands
): { mcpPanel: MobileStructuredMcpPanel | null; commands: TCommands & McpCommands } {
  const { client, sessionId, agent } = session
  const relayed = useRouteRelaysCapability(AGENT_SESSION_MCP_RUNTIME_CAPABILITY)
  // One hook serves every chat tab, so the sheet belongs to the conversation that opened it.
  const [openFor, setOpenFor] = useState<string | null>(null)
  const sheetOpen = openFor === sessionKey
  // A reconnect clears host support until it is read again; an open sheet mid sign-in must keep
  // its paste box through that gap.
  const hostReported = session.hostSupport ? session.hostSupport.mcp === true && relayed : undefined
  const [hostKnown, setHostKnown] = useState(false)
  if (hostReported !== undefined && hostKnown !== hostReported) {
    setHostKnown(hostReported)
  }
  const hostManages = session.enabled && (hostReported ?? (sheetOpen && hostKnown))
  const registered = useMobileRegisteredAgent(client, hostManages, agent)
  // A reconnect re-reads the agents; an open sheet (mid sign-in, after a trip to the browser) stays.
  const [known, setKnown] = useState<{ client: unknown; agent: string | null; mcp: boolean }>()
  const sameChat = known !== undefined && known.client === client && known.agent === agent
  const reported = registered ? registered.capabilities.mcpServers === true : undefined
  if (reported !== undefined && !(sameChat && known.mcp === reported)) {
    setKnown({ client, agent, mcp: reported })
  }
  const agentManages = reported ?? (sameChat && known.mcp)
  const offered = hostManages && agentManages && !!client && !!sessionId
  const open = offered && sheetOpen
  const show = useCallback(() => setOpenFor(sessionKey), [sessionKey])
  const close = useCallback(() => setOpenFor(null), [])
  const request = useCallback(
    async (operation: AgentSessionMcpOperation): Promise<AgentSessionMcpResult> => {
      if (!client || !sessionId) {
        return { status: 'failed', message: null }
      }
      return await callAgentSession<AgentSessionMcpResult>(
        client,
        'agentSession.mcp',
        { sessionId, operation },
        MCP_TIMEOUT_MS,
        // Sign-in polls must not pile up behind a dropped connection.
        operation.action === 'status' ? { failWhenDisconnected: true } : undefined
      )
    },
    [client, sessionId]
  )
  const mcpPanel = useMemo(
    () => (offered ? { open, close, request } : null),
    [close, offered, open, request]
  )
  const mcpCommands = useMemo(
    () => ({ ...commands, openMcpPanel: offered ? show : undefined }),
    [commands, offered, show]
  )
  return { mcpPanel, commands: mcpCommands }
}

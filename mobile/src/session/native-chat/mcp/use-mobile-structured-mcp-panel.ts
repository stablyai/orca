import { useCallback, useMemo, useState } from 'react'
import { useRouter } from 'expo-router'
import type {
  AgentSessionMcpOperation,
  AgentSessionMcpResult
} from '../../../../../src/shared/agent-session/options/protocol/agent-session-mcp'
import { tuiAgentDisplayName } from '../../../../../src/shared/agent-launch/catalog/tui-agent-display-names'
import { AGENT_SESSION_MCP_RUNTIME_CAPABILITY } from '../../../../../src/shared/agent-session/capabilities/agent-session-runtime-capabilities'
import type { StructuredAgentSessionComposerOptions } from '../../../../../src/shared/agent-session/view/structured-agent-session-composer'
import type { AgentSessionMcpRequest } from '../../../../../src/shared/agent-session/view/use-agent-session-mcp-panel'
import { useRouteRelaysCapability } from '../../../worktree/execution-hosts/workspace-server-context'
import type { MobileStructuredAgentSessionArgs } from '../agent-session/mobile-structured-agent-session-contract'
import { callAgentSession } from '../agent-session/mobile-structured-agent-session-rpc'
import { useMobileRegisteredAgent } from '../agent-session/use-mobile-registered-agent'
import { useMobileStructuredSessionHostExecutionPhase } from '../agent-session/use-mobile-structured-session-host-execution'
import type { RpcClient } from '../../../transport/rpc/rpc-client-contract'

// A cold Codex read or a Claude sign-in finish (exchange, reconnect, re-read) can run long.
const MCP_TIMEOUT_MS = 90_000

export type MobileStructuredMcpPanel = {
  open: boolean
  close: () => void
  request: AgentSessionMcpRequest
  /** Changes when `/mcp` runs again or the agent starts or stops, so the tray re-reads. */
  refreshKey: string
  /** Opens the host's MCP servers page; null on a host without one. */
  manage: (() => void) | null
  /** The chat's agent, as the tray names it. */
  agentLabel: string
  /** The host's list of MCP servers, which Orca checks and signs in to itself before the agent
   *  starts; null on a host without one. */
  orca: { client: RpcClient; agent: string; hostId: string; online: boolean } | null
}

type McpCommands = Pick<StructuredAgentSessionComposerOptions, 'openMcpPanel'>

/** The chat's `/mcp` tray, offered where the host manages this agent's MCP servers. */
export function useMobileStructuredMcpPanel<TCommands extends object>(
  session: Pick<
    MobileStructuredAgentSessionArgs,
    'client' | 'sessionId' | 'agent' | 'hostSupport' | 'enabled' | 'hostId' | 'connected'
  >,
  sessionKey: string,
  commands: TCommands
): { mcpPanel: MobileStructuredMcpPanel | null; commands: TCommands & McpCommands } {
  const { client, sessionId, agent } = session
  const relayed = useRouteRelaysCapability(AGENT_SESSION_MCP_RUNTIME_CAPABILITY)
  // One hook serves every chat tab, so the tray belongs to the conversation that opened it.
  const [openFor, setOpenFor] = useState<string | null>(null)
  const [opens, setOpens] = useState(0)
  const trayOpen = openFor === sessionKey
  // An agent at rest has no servers to list; the tray re-reads once it starts or stops.
  const phase = useMobileStructuredSessionHostExecutionPhase({
    client,
    sessionId,
    enabled: trayOpen && session.enabled && session.hostSupport?.statusFeed === true
  })
  // A reconnect clears host support until it is read again; an open tray mid sign-in must keep
  // its paste box through that gap.
  const hostReported = session.hostSupport ? session.hostSupport.mcp === true && relayed : undefined
  const [hostKnown, setHostKnown] = useState(false)
  if (hostReported !== undefined && hostKnown !== hostReported) {
    setHostKnown(hostReported)
  }
  const hostManages = session.enabled && (hostReported ?? (trayOpen && hostKnown))
  const registered = useMobileRegisteredAgent(client, hostManages, agent)
  // A reconnect re-reads the agents; an open tray (mid sign-in, after a trip to the browser) stays.
  const [known, setKnown] = useState<{ client: unknown; agent: string | null; mcp: boolean }>()
  const sameChat = known !== undefined && known.client === client && known.agent === agent
  const reported = registered ? registered.capabilities.mcpServers === true : undefined
  if (reported !== undefined && !(sameChat && known.mcp === reported)) {
    setKnown({ client, agent, mcp: reported })
  }
  const agentManages = reported ?? (sameChat && known.mcp)
  const offered = hostManages && agentManages && !!client && !!sessionId
  const open = offered && trayOpen
  const show = useCallback(() => {
    setOpenFor(sessionKey)
    setOpens((count) => count + 1)
  }, [sessionKey])
  const close = useCallback(() => setOpenFor(null), [])
  const router = useRouter()
  const { hostId } = session
  // Only a host whose MCP servers are on has a page for them; an open tray keeps that through a
  // reconnect, so a sign-in under way keeps its client.
  const listsReported = session.hostSupport ? session.hostSupport.mcpServers === true : undefined
  const [listsKnown, setListsKnown] = useState(false)
  if (listsReported !== undefined && listsKnown !== listsReported) {
    setListsKnown(listsReported)
  }
  const hostListsServers = listsReported ?? (trayOpen && listsKnown)
  const manage = useCallback(() => {
    setOpenFor(null)
    router.push(`/h/${encodeURIComponent(hostId ?? '')}/mcp`)
  }, [hostId, router])
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
  const refreshKey = `${opens}:${phase}`
  const canManage = hostListsServers && !!hostId
  const agentLabel = agent ? (tuiAgentDisplayName(agent) ?? agent) : ''
  const online = session.connected
  const orca = useMemo(
    () => (canManage && client && agent ? { client, agent, hostId: hostId ?? '', online } : null),
    [agent, canManage, client, hostId, online]
  )
  const mcpPanel = useMemo(
    () =>
      offered
        ? { open, close, request, refreshKey, manage: canManage ? manage : null, agentLabel, orca }
        : null,
    [agentLabel, canManage, close, manage, offered, open, orca, refreshKey, request]
  )
  const mcpCommands = useMemo(
    () => ({ ...commands, openMcpPanel: offered ? show : undefined }),
    [commands, offered, show]
  )
  return { mcpPanel, commands: mcpCommands }
}

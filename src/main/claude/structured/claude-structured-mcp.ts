import type { McpServerStatus } from '@anthropic-ai/claude-agent-sdk'
import {
  agentSessionMcpFailureMessage,
  agentSessionMcpWebUrl,
  type AgentSessionMcpOperation,
  type AgentSessionMcpResult,
  type AgentSessionMcpServer,
  type AgentSessionMcpSignIn
} from '../../../shared/agent-session/agent-session-mcp'
import {
  isClaudeQueryClosed,
  type ClaudeMcpControls
} from '../sdk-transport/claude-agent-sdk-control-requests'
import type { ClaudeSession } from './claude-structured-session-state'

// The CLI refuses OAuth for stdio and sdk servers.
const SIGN_IN_TRANSPORTS = new Set(['http', 'sse', 'claudeai-proxy'])

export function claudeMcpServer(row: McpServerStatus): AgentSessionMcpServer {
  return {
    name: row.name,
    status: row.status,
    source: row.source ?? row.scope ?? null,
    toolCount: row.status === 'connected' ? (row.tools?.length ?? 0) : null,
    error: row.status === 'failed' ? agentSessionMcpFailureMessage(row.error ?? '') : null,
    // A disabled server must be enabled before the CLI will authenticate it.
    canSignIn: SIGN_IN_TRANSPORTS.has(row.config?.type ?? 'stdio') && row.status !== 'disabled',
    canReconnect: row.status !== 'disabled',
    canToggle: true
  }
}

async function runClaudeMcpOperation(
  mcp: ClaudeMcpControls,
  operation: AgentSessionMcpOperation
): Promise<AgentSessionMcpSignIn | undefined> {
  switch (operation.action) {
    case 'status':
      return undefined
    case 'signIn': {
      const { authUrl, callbackExpected } = await mcp.authenticate(operation.server)
      const url = agentSessionMcpWebUrl(authUrl)
      // claude.ai connectors finish on claude.ai; others wait on the CLI's localhost callback.
      return url
        ? { server: operation.server, url, finish: callbackExpected ? 'callback' : 'external' }
        : undefined
    }
    case 'finishSignIn':
      await mcp.submitOAuthCallbackUrl(operation.server, operation.callbackUrl)
      await mcp.reconnect(operation.server)
      return undefined
    case 'reconnect':
      await mcp.reconnect(operation.server)
      return undefined
    case 'toggle':
      await mcp.toggle(operation.server, operation.enabled)
      return undefined
  }
}

export async function manageClaudeMcp(
  sessions: ReadonlyMap<string, ClaudeSession>,
  sessionId: string,
  operation: AgentSessionMcpOperation
): Promise<AgentSessionMcpResult> {
  const session = sessions.get(sessionId)
  const connection = session?.connection
  if (!session || !connection || connection.closed) {
    return { status: 'not-running' }
  }
  const mcp = connection.mcp
  if (!mcp) {
    return { status: 'unsupported' }
  }
  const live = (): boolean =>
    sessions.get(sessionId) === session && session.connection === connection && !connection.closed
  try {
    const signIn = await runClaudeMcpOperation(mcp, operation)
    const servers = (await mcp.status()).map(claudeMcpServer)
    if (!live()) {
      return { status: 'not-running' }
    }
    return signIn ? { status: 'ok', servers, signIn } : { status: 'ok', servers }
  } catch (error) {
    if (!live() || isClaudeQueryClosed(error)) {
      return { status: 'not-running' }
    }
    throw error
  }
}

import type { McpServerStatus } from '@anthropic-ai/claude-agent-sdk'
import type {
  AgentSessionMcpAction,
  AgentSessionMcpResult,
  AgentSessionMcpServer
} from '../../../shared/agent-session/agent-session-mcp'
import type { ClaudeSession } from './claude-structured-session-state'

const pending = new WeakSet<ClaudeSession>()

function canAuthenticate(server: McpServerStatus): boolean {
  return (
    (server.config?.type === 'http' || server.config?.type === 'sse') &&
    ['user', 'project', 'local'].includes(server.source ?? server.scope ?? '')
  )
}

function publicServer(server: McpServerStatus): AgentSessionMcpServer {
  return {
    name: server.name,
    status: server.status,
    canAuthenticate: canAuthenticate(server)
  }
}

export async function manageClaudeMcp(
  sessions: ReadonlyMap<string, ClaudeSession>,
  sessionId: string,
  input: AgentSessionMcpAction
): Promise<AgentSessionMcpResult> {
  const session = sessions.get(sessionId)
  const connection = session?.connection
  if (!session || !connection?.mcpServerStatus || connection.closed) {
    return { status: 'unavailable' }
  }
  const current = () =>
    sessions.get(sessionId) === session && session.connection === connection && !connection.closed
  if (input.action !== 'status' && pending.has(session)) {
    return { status: 'busy' }
  }
  if (input.action !== 'status') {
    pending.add(session)
  }
  try {
    let servers = await connection.mcpServerStatus()
    if (!current()) {
      return { status: 'session-changed' }
    }
    if (input.action !== 'status') {
      const server = servers.find((entry) => entry.name === input.server)
      if (!server) {
        return { status: 'unavailable' }
      }
      if (input.action === 'authenticate') {
        if (!canAuthenticate(server) || !connection.loginMcp || !connection.reconnectMcpServer) {
          return { status: 'unavailable' }
        }
        await connection.loginMcp(server.name)
        if (!current()) {
          return { status: 'session-changed' }
        }
        await connection.reconnectMcpServer(server.name)
      } else if (input.action === 'reconnect') {
        if (!connection.reconnectMcpServer) {
          return { status: 'unavailable' }
        }
        await connection.reconnectMcpServer(server.name)
      } else {
        if (!connection.toggleMcpServer) {
          return { status: 'unavailable' }
        }
        await connection.toggleMcpServer(server.name, input.enabled)
      }
      servers = await connection.mcpServerStatus()
    }
    return current()
      ? { status: 'ok', servers: servers.map(publicServer) }
      : { status: 'session-changed' }
  } catch {
    // Provider errors can contain OAuth URLs or server headers.
    return { status: current() ? 'failed' : 'session-changed' }
  } finally {
    if (input.action !== 'status') {
      pending.delete(session)
    }
  }
}

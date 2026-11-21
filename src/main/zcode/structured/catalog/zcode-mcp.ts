import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import type {
  AgentSessionMcpOperation,
  AgentSessionMcpResult,
  AgentSessionMcpServer,
  AgentSessionMcpServerStatus
} from '../../../../shared/agent-session/options/protocol/agent-session-mcp'
import type { ZcodeStructuredSession } from '../session-lifecycle/zcode-structured-session'

// The MCP panel reads a live child's `mcp/list` (mode `connect`: connect attempts ride the read).
// Resting chats report not-running — zcode's panel is a live surface, like Claude's. The backend
// has no client-side toggle/reconnect/oauth RPC: signIn happens through the backend's own official
// MCP auth ask (which Orca declines), so only status is available.

const ZCODE_MCP_LIST_METHOD = 'mcp/list'
const ZCODE_MCP_LIST_TIMEOUT_MS = 30_000

/** zcode's per-server status row of the `mcp/list` answer. */
type ZcodeMcpStatusRow = {
  status?: unknown
  toolCount?: unknown
  error?: unknown
}

export async function manageZcodeSessionMcp(
  sessions: Map<string, ZcodeStructuredSession>,
  record: AgentSessionRecord,
  operation: AgentSessionMcpOperation
): Promise<AgentSessionMcpResult> {
  if (operation.action !== 'status') {
    return { status: 'unsupported' }
  }
  const session = sessions.get(record.sessionId)
  if (!session || session.ended || !session.providerSessionId) {
    return { status: 'not-running' }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: zcode app-server frames and provider responses own these payload shapes.
  const result = (await session.connection.request(
    ZCODE_MCP_LIST_METHOD,
    {
      workspace: { workspacePath: session.deps.launch.cwd, workspaceKey: session.deps.launch.cwd },
      mode: 'connect'
    },
    { timeoutMs: ZCODE_MCP_LIST_TIMEOUT_MS }
  )) as { statuses?: unknown } | null
  const servers = readZcodeMcpServers(result)
  return { status: 'ok', servers }
}

/** Map the `statuses` record to panel rows; an unreadable answer reads as an empty list. */
export function readZcodeMcpServers(result: unknown): AgentSessionMcpServer[] {
  if (typeof result !== 'object' || result === null) {
    return []
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: zcode app-server frames and provider responses own these payload shapes.
  const statuses = (result as { statuses?: unknown }).statuses
  if (typeof statuses !== 'object' || statuses === null) {
    return []
  }
  const servers: AgentSessionMcpServer[] = []
  for (const [name, row] of Object.entries(statuses)) {
    if (typeof row !== 'object' || row === null) {
      continue
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: zcode app-server frames and provider responses own these payload shapes.
    const entry = row as ZcodeMcpStatusRow
    const toolCount = typeof entry.toolCount === 'number' ? entry.toolCount : null
    const status = zcodeMcpStatusOf(entry.status)
    servers.push({
      name,
      status,
      source: null,
      toolCount: status === 'connected' ? toolCount : null,
      error: status === 'failed' ? (typeof entry.error === 'string' ? entry.error : null) : null,
      canSignIn: false,
      canReconnect: false,
      canToggle: false
    })
  }
  return servers.sort((left, right) => left.name.localeCompare(right.name))
}

/** zcode's status vocabulary onto the panel's; untrusted surfaces as a failure to run. */
function zcodeMcpStatusOf(status: unknown): AgentSessionMcpServerStatus {
  if (status === 'connected') {
    return 'connected'
  }
  if (status === 'connecting' || status === 'disconnected') {
    return 'pending'
  }
  if (status === 'disabled') {
    return 'disabled'
  }
  return 'failed'
}

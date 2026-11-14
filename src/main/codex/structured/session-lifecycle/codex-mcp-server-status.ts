import type {
  AgentSessionMcpServer,
  AgentSessionMcpServerStatus
} from '../../../../shared/agent-session/agent-session-mcp'
import type { CodexAppServerRpc } from '../../app-server/codex-app-server-session'

export type CodexMcpRequest = CodexAppServerRpc['request']

// Without a thread, Codex opens a fresh connection to every server to answer.
export const CODEX_MCP_RPC_TIMEOUT_MS = 30_000
const MAX_STATUS_PAGES = 20
const ERROR_MAX_CHARS = 160

const RUNTIME_STATUS: Record<string, AgentSessionMcpServerStatus> = {
  connected: 'connected',
  notStarted: 'pending',
  starting: 'pending',
  authenticationRequired: 'needs-auth',
  failed: 'failed',
  cancelled: 'failed',
  disabled: 'disabled'
}

type CodexMcpServerStatusEntry = {
  name: string
  runtimeStatus?: string | null
  pluginId?: string | null
  tools?: Record<string, unknown> | null
  toolsError?: string | null
  authStatus?: string | null
}

type CodexMcpConfig = {
  disabled: ReadonlySet<string>
  /** Only servers in the home's own config.toml take an `enabled` write. */
  userDeclared: ReadonlySet<string>
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** `threadId` reads the running thread's connections; without one Codex probes each server itself. */
export async function listCodexMcpServers(
  request: CodexMcpRequest,
  scope: { threadId: string | null; cwd: string | null }
): Promise<AgentSessionMcpServer[]> {
  const config = await readCodexMcpConfig(request, scope.cwd)
  const entries: CodexMcpServerStatusEntry[] = []
  let cursor: string | null = null
  for (let page = 0; page < MAX_STATUS_PAGES; page++) {
    const reply = await request(
      'mcpServerStatus/list',
      {
        detail: 'toolsAndAuthOnly',
        ...(scope.threadId ? { threadId: scope.threadId } : {}),
        ...(cursor ? { cursor } : {})
      },
      { timeoutMs: CODEX_MCP_RPC_TIMEOUT_MS }
    )
    const data = isRecord(reply) && Array.isArray(reply.data) ? reply.data : []
    for (const entry of data) {
      if (isRecord(entry) && typeof entry.name === 'string') {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Codex's McpServerStatus; every field read below is optional.
        entries.push(entry as CodexMcpServerStatusEntry)
      }
    }
    cursor = isRecord(reply) && typeof reply.nextCursor === 'string' ? reply.nextCursor : null
    if (!cursor) {
      break
    }
  }
  return entries.map((entry) => codexMcpServerRow(entry, config, scope.threadId !== null))
}

async function readCodexMcpConfig(
  request: CodexMcpRequest,
  cwd: string | null
): Promise<CodexMcpConfig> {
  const reply = await request(
    'config/read',
    { includeLayers: true, ...(cwd ? { cwd } : {}) },
    { timeoutMs: CODEX_MCP_RPC_TIMEOUT_MS }
  )
  const servers = isRecord(reply) && isRecord(reply.config) ? reply.config.mcp_servers : null
  const disabled = new Set(
    isRecord(servers)
      ? Object.entries(servers)
          .filter(([, server]) => isRecord(server) && server.enabled === false)
          .map(([name]) => name)
      : []
  )
  const layers = isRecord(reply) && Array.isArray(reply.layers) ? reply.layers : []
  const user = layers.find(
    (layer): layer is Record<string, unknown> =>
      isRecord(layer) && isRecord(layer.name) && layer.name.type === 'user'
  )
  const userConfig = user?.config
  const userServers = isRecord(userConfig) ? userConfig.mcp_servers : null
  return { disabled, userDeclared: new Set(isRecord(userServers) ? Object.keys(userServers) : []) }
}

function codexMcpServerRow(
  entry: CodexMcpServerStatusEntry,
  config: CodexMcpConfig,
  live: boolean
): AgentSessionMcpServer {
  // Config decides disabled: a thread may still report the connection a toggle just closed.
  const status: AgentSessionMcpServerStatus = config.disabled.has(entry.name)
    ? 'disabled'
    : entry.runtimeStatus
      ? (RUNTIME_STATUS[entry.runtimeStatus] ?? 'pending')
      : entry.authStatus === 'notLoggedIn'
        ? 'needs-auth'
        : entry.toolsError
          ? 'failed'
          : 'connected'
  return {
    name: entry.name,
    status,
    source: entry.pluginId ? 'plugin' : null,
    toolCount: status === 'connected' ? Object.keys(entry.tools ?? {}).length : null,
    error: status === 'failed' ? readableCodexMcpError(entry.toolsError) : null,
    // Codex's OAuth callback listener lives in the app-server, which only a running chat keeps up.
    canSignIn:
      live &&
      status !== 'disabled' &&
      (entry.authStatus === 'notLoggedIn' || entry.authStatus === 'oAuth'),
    // `config/mcpServer/reload` restarts a failed server only on a running thread.
    canReconnect: live && status === 'failed',
    canToggle:
      !entry.pluginId && config.userDeclared.has(entry.name) && CODEX_MCP_TOML_KEY.test(entry.name)
  }
}

/** The `enabled` write's key path takes the name as one bare TOML key segment. */
export const CODEX_MCP_TOML_KEY = /^[\w-]+$/

/** Codex reports rmcp's error chain with Rust type paths; keep its innermost cause. */
export function readableCodexMcpError(raw: string | null | undefined): string | null {
  const text = (raw ?? '')
    .replace(/\s*\[[^\]]*\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  const at = text.lastIndexOf('error: ')
  const cause = (at !== -1 ? text.slice(at + 'error: '.length) : text)
    .replace(/, when send \w+ request$/, '')
    .trim()
  return cause ? `${cause[0].toUpperCase()}${cause.slice(1)}`.slice(0, ERROR_MAX_CHARS) : null
}

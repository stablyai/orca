// An ACP agent's bot tools reach it as the `mcpServers` of the session it opens or reopens, sent over
// stdin, so they need no folder trust or config file, and a session started anywhere else never sees them.
import type { InitializeResponse, McpServer } from '../acp/generated/acp-protocol.generated'
import {
  acpTakesHttpTools,
  readAcpTakesHttpTools
} from '../acp/capabilities/acp-initialize-capabilities'
import type { BotToolServer } from '../../shared/bot-tools'
import type { BotLaunchTools } from './bot-launch-tools'

const pairs = (record: Readonly<Record<string, string>> | undefined) =>
  Object.entries(record ?? {}).map(([name, value]) => ({ name, value }))

const atUrl = (server: BotToolServer) => 'url' in server

const httpToolsOffReason = (agentName: string, version: string | null | undefined) =>
  `${agentName}${version ? ` ${version}` : ''} doesn't take tools at a URL. Update it to turn them on.`

export function acpBotMcpServers(tools: BotLaunchTools): McpServer[] {
  return tools.servers.map((server) =>
    'url' in server
      ? { type: 'http', name: server.name, url: server.url, headers: pairs(server.headers) }
      : { name: server.name, command: server.command, args: server.args, env: pairs(server.env) }
  )
}

/** The tools this release takes, as its last `initialize` said; one not seen yet gets all of them. */
export function acpLaunchBotTools(
  tools: BotLaunchTools,
  agent: { id: string; name: string; version: string | null }
): {
  tools: BotLaunchTools
  note: string | null
  /** The handshake's `initialize` turned the URL tools down after all. */
  httpToolsOff?: (reason: string) => void
} {
  if (readAcpTakesHttpTools(agent.id) === false) {
    return tools.without(atUrl, httpToolsOffReason(agent.name, agent.version))
  }
  return tools.servers.some(atUrl)
    ? { tools, note: null, httpToolsOff: (reason) => void tools.without(atUrl, reason) }
    : { tools, note: null }
}

/** The servers a session opens with: ones at a URL only when the agent advertises taking them. */
export function acpSessionMcpServers(
  launch: { mcpServers?: McpServer[]; httpToolsOff?: (reason: string) => void },
  initialized: InitializeResponse,
  agentName: string
): McpServer[] {
  const servers = launch.mcpServers ?? []
  const kept = servers.filter((server) => !('type' in server && server.type === 'http'))
  if (kept.length === servers.length || acpTakesHttpTools(initialized)) {
    return servers
  }
  launch.httpToolsOff?.(httpToolsOffReason(agentName, initialized.agentInfo?.version))
  return kept
}

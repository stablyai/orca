// The host list's servers each chat actually got, after its agent's own same-named servers won, so
// its `/mcp` tray can show them as Orca's.
import type { AgentSessionMcpResult } from '../../shared/agent-session/options/protocol/agent-session-mcp'
import { BoundedMap } from '../../shared/collections/bounded-map'
import type { SessionMcpTools } from './session-mcp-tools'
import { agentOwnMcpServerNames } from './agent-own-mcp-server-names'

/** The tray's group for servers from the host's list. */
export const ORCA_MCP_SOURCE = 'orca'

const delivered = new BoundedMap<string, ReadonlySet<string>>({ maxEntries: 2_000 })

/**
 * `tools` without the host list's servers the agent's own config already names (`ownNames` reads
 * them, only when there are any), which would merge into or shadow its own; its own runs instead.
 * What's left is noted as the session's, for its tray.
 */
export async function deliverHostMcpServers(
  sessionId: string,
  agent: string,
  tools: SessionMcpTools,
  ownNames: () => Promise<readonly string[]>
): Promise<SessionMcpTools> {
  if (tools.hostNames.size === 0) {
    delivered.delete(sessionId)
    return tools
  }
  const { tools: kept, skipped } = tools.beside(await ownNames())
  if (skipped.length > 0) {
    console.warn(
      `[mcp-servers] ${agent}'s own settings already have ${skipped.join(', ')}; this session uses those instead of Orca's`
    )
  }
  delivered.set(sessionId, kept.hostNames)
  return kept
}

/** The agent's answer with the servers this session got from the host's list under Orca's group. */
export function withOrcaMcpSource(
  sessionId: string,
  result: AgentSessionMcpResult
): AgentSessionMcpResult {
  const names = delivered.peek(sessionId)
  if (result.status !== 'ok' || !names) {
    return result
  }
  return {
    ...result,
    servers: result.servers.map((server) =>
      names.has(server.name) ? { ...server, source: ORCA_MCP_SOURCE } : server
    )
  }
}

/**
 * The launch's servers (`basis.toolServers()`) beside the ones `agent`'s own config files name in
 * `cwd`, and `also`. `hostOff`: the agent ignores a session's servers, so none of the host list's.
 */
export async function deliverHostMcpServersBesideConfig(
  basis: { record: { sessionId: string }; toolServers(): Promise<SessionMcpTools> },
  agent: string,
  launch: { env: NodeJS.ProcessEnv; cwd: string; also?: readonly string[]; hostOff?: boolean }
): Promise<SessionMcpTools> {
  const tools = await basis.toolServers()
  const offered = launch.hostOff ? tools.beside(tools.hostNames).tools : tools
  return deliverHostMcpServers(basis.record.sessionId, agent, offered, async () => [
    ...(launch.also ?? []),
    ...(await agentOwnMcpServerNames(agent, launch.env, launch.cwd))
  ])
}

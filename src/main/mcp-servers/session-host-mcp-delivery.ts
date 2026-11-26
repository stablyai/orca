// The host list's servers each chat actually got, after its agent's own same-named servers won, so
// its `/mcp` tray can show them as Orca's and an edit to one it didn't get never restarts it.
import type { AgentSessionMcpResult } from '../../shared/agent-session/options/protocol/agent-session-mcp'
import { BoundedMap } from '../../shared/collections/bounded-map'
import { ORCA_MCP_SOURCE } from '../../shared/agent-session/view/agent-session-mcp-server-presentation'
import type { SessionMcpTools } from './session-mcp-tools'
import { agentOwnMcpServerNames } from './agent-own-mcp-server-names'

const delivered = new BoundedMap<string, ReadonlySet<string>>({ maxEntries: 2_000 })
/** Chats whose agent ignores a session's servers: no host-list edit is theirs. */
const ignoring = new BoundedMap<string, true>({ maxEntries: 2_000 })

/**
 * Which host-list servers the chat got at its last launch: `'ignored'` when its agent took none
 * whatever the list said, undefined when not known (a launch read the bound pushed out). Read with
 * its launch record, so the two stay in the bound together.
 */
export function sessionHostMcpDelivered(
  sessionId: string
): ReadonlySet<string> | 'ignored' | undefined {
  const names = delivered.get(sessionId)
  return ignoring.get(sessionId) ? 'ignored' : names
}

/** The chat's agent takes none of the host list's servers this launch (managed settings refuse
 *  them, or it ignores a session's servers), so no edit to the list is the chat's. */
export function noteSessionIgnoresHostMcp(sessionId: string, ignores: boolean): void {
  if (ignores) {
    ignoring.set(sessionId, true)
  } else {
    ignoring.delete(sessionId)
  }
}

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
    delivered.set(sessionId, tools.hostNames)
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
  noteSessionIgnoresHostMcp(basis.record.sessionId, launch.hostOff === true)
  const offered = launch.hostOff ? tools.beside(tools.hostNames).tools : tools
  return deliverHostMcpServers(basis.record.sessionId, agent, offered, async () => [
    ...(launch.also ?? []),
    ...(await agentOwnMcpServerNames(agent, launch.env, launch.cwd))
  ])
}

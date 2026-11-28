// The host list's servers each chat actually got, after its agent's own same-named servers won, so
// its `/mcp` tray can show them as Orca's and an edit to one it didn't get never restarts it.
import type { AgentSessionMcpResult } from '../../shared/agent-session/options/protocol/agent-session-mcp'
import { BoundedMap } from '../../shared/collections/bounded-map'
import { ORCA_MCP_SOURCE } from '../../shared/agent-session/view/agent-session-mcp-server-presentation'
import type { SessionMcpTools } from './session-mcp-tools'
import { agentOwnMcpServerNames } from './agent-own-mcp-server-names'
import { SIGN_IN_NEEDED } from '../bots/tool-relay/bot-tool-relay-sign-in-answer'

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
    servers: result.servers.map((server) => {
      if (!names.has(server.name)) {
        return server
      }
      // Agents report the relay's "sign in" answer as a failed connect; Orca signs in, not the agent.
      return server.status === 'failed' && server.error?.includes(SIGN_IN_NEEDED)
        ? {
            ...server,
            status: 'needs-auth',
            error: null,
            canSignIn: false,
            source: ORCA_MCP_SOURCE
          }
        : { ...server, source: ORCA_MCP_SOURCE }
    })
  }
}

/** Orca's rows, the agent's or the ones Orca lists for it, marked when Orca removed or changed them since launch. */
export function withOrcaMcpChanges(
  result: AgentSessionMcpResult,
  changes: ReadonlyMap<string, 'removed' | 'changed'> | undefined
): AgentSessionMcpResult {
  if (result.status !== 'ok' || !changes || changes.size === 0) {
    return result
  }
  return {
    ...result,
    servers: result.servers.map((server) => {
      const change = server.source === ORCA_MCP_SOURCE ? changes.get(server.name) : undefined
      return change ? { ...server, orcaChange: change } : server
    })
  }
}

/** A reconnect to an Orca server the list no longer has would only fail again: say why instead. */
export function refuseRemovedOrcaReconnect(
  sessionId: string,
  server: string,
  changes: ReadonlyMap<string, 'removed' | 'changed'>
): AgentSessionMcpResult | null {
  return changes.get(server) === 'removed' && delivered.peek(sessionId)?.has(server)
    ? {
        status: 'failed',
        message: 'Orca removed this server. Your next message restarts the chat without it.'
      }
    : null
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

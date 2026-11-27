// The `/mcp` tray's rows for a chat whose agent can't list its servers: before its first message,
// or an agent with no `/mcp` of its own. Orca knows what its next launch gets from the host list,
// and the agent's own servers from its config files.
import type {
  AgentSessionMcpResult,
  AgentSessionMcpServer,
  AgentSessionMcpServerStatus
} from '../../shared/agent-session/options/protocol/agent-session-mcp'
import { ORCA_MCP_SOURCE } from '../../shared/agent-session/view/agent-session-mcp-server-presentation'
import { mcpServerWorkspaceKeyOf } from '../../shared/mcp-servers/mcp-servers'
import { acpLaunchSpecFor } from '../acp/launch/acp-launch-registry'
import { botOwnTools } from '../bots/bot-tools-file'
import { claudeConfigDirEnvPatch } from '../claude/structured/launch/claude-config-dir-pin'
import { agentOwnMcpConfig } from './agent-own-mcp-server-names'
import type { AgentMcpConfigServer } from './agent-configs/agent-mcp-config-read'
import { isMcpAgentBlocked } from './mcp-agent-problems'
import { mcpHostListFolder } from './mcp-host-list-folder'
import { mcpServersForLaunch } from './mcp-host-list-launch'
import { sessionHostMcpDelivered } from './session-host-mcp-delivery'

export type KnownMcpLaunch = {
  sessionId: string
  agent: string
  workspaceId: string
  /** Where its next launch runs; null when unknown, so no folder's files are read. */
  cwd: string | null
  /** The account folder its next turn launches on. */
  accountHome: string | null
  /** Its agent is running, or starting. */
  running: boolean
  /** The agent answers `/mcp` itself. */
  manages: boolean
}

/**
 * The agent's answer with the rows Orca knows. An agent at rest answers `not-running` (Claude) or
 * lists only its own (Codex); one with no `/mcp` of its own lists nothing, so Orca lists what it
 * launched with, none reported. Call only with the host's MCP servers switch on.
 */
export async function withKnownSessionMcpServers(
  answer: AgentSessionMcpResult,
  launch: KnownMcpLaunch
): Promise<AgentSessionMcpResult> {
  try {
    if (answer.status === 'ok') {
      // An agent at rest lists its own config, never Orca's servers its launch would add.
      return launch.running
        ? answer
        : { ...answer, servers: [...answer.servers, ...(await orcaRows(launch, answer.servers))] }
    }
    if (answer.status === 'not-running' || (answer.status === 'unsupported' && !launch.manages)) {
      const resting = answer.status === 'not-running' || !launch.running
      const servers = await knownRows(launch, resting ? 'not-started' : 'unreported')
      if (resting) {
        return servers.length > 0 ? { status: 'not-running', servers } : answer
      }
      return { status: 'ok', servers }
    }
  } catch (error) {
    console.warn('[mcp-servers] the chat’s servers could not be read', error)
  }
  return answer
}

async function knownRows(
  launch: KnownMcpLaunch,
  status: 'not-started' | 'unreported'
): Promise<AgentSessionMcpServer[]> {
  const env =
    launch.agent === 'claude' && launch.accountHome
      ? { ...process.env, ...claudeConfigDirEnvPatch(launch.accountHome) }
      : process.env
  const own = await agentOwnMcpConfig(launch.agent, env, launch.cwd)
  const taken = own.names.map((name) => ({ name }))
  return [
    ...(await orcaRows(launch, taken, status)),
    ...own.servers.map((entry) => ownRow(launch.agent, entry, status))
  ]
}

/** The host list's servers the launch gets, less those `taken` by the agent's own, as delivery skips them. */
async function orcaRows(
  launch: KnownMcpLaunch,
  taken: readonly { name: string }[],
  status: 'not-started' | 'unreported' = 'not-started'
): Promise<AgentSessionMcpServer[]> {
  // A running agent got what its launch decided; one that ignores a session's servers got none.
  const delivered = launch.running ? sessionHostMcpDelivered(launch.sessionId) : undefined
  if (
    delivered === 'ignored' ||
    isMcpAgentBlocked(launch.agent) ||
    acpLaunchSpecFor(launch.agent)?.botToolsOff
  ) {
    return []
  }
  const folder = mcpHostListFolder()
  const key = mcpServerWorkspaceKeyOf(launch.workspaceId)
  const { servers } = await mcpServersForLaunch(launch.agent, { key }, folder)
  const skip = new Set(taken.map(({ name }) => name))
  const kept = servers.filter((server) =>
    delivered ? delivered.has(server.name) : !skip.has(server.name)
  )
  return botOwnTools(kept, folder).map(({ name, signIn }) =>
    row(name, ORCA_MCP_SOURCE, signIn && signIn.state !== 'signed-in' ? 'needs-auth' : status)
  )
}

function ownRow(
  agent: string,
  { configName, disabled, source }: AgentMcpConfigServer,
  status: 'not-started' | 'unreported'
): AgentSessionMcpServer {
  // Claude keeps a folder's own servers in its user file: its `/mcp` calls them local.
  const scope =
    source.scope === 'project'
      ? 'project'
      : agent === 'claude' && source.projectPath
        ? 'local'
        : 'user'
  return row(configName, scope, disabled ? 'disabled' : status)
}

const row = (
  name: string,
  source: string,
  status: AgentSessionMcpServerStatus
): AgentSessionMcpServer => ({
  name,
  status,
  source,
  toolCount: null,
  error: null,
  canSignIn: false,
  canReconnect: false,
  canToggle: false
})

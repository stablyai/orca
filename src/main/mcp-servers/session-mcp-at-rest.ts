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
import type { AgentMcpConfigName } from './agent-configs/agent-mcp-config-read'
import { isMcpAgentBlocked } from './mcp-agent-problems'
import { mcpHostListFolder } from './mcp-host-list-folder'
import { mcpServersForLaunch } from './mcp-host-list-launch'
import { sessionHostMcpDelivered } from './session-host-mcp-delivery'

export type KnownMcpLaunch = {
  sessionId: string
  agent: string
  workspaceId: string
  /** Where its next launch runs; null when unknown, so no folder's files are read. */
  cwd: () => Promise<string | null>
  /** The account folder its next turn launches on. */
  accountHome: string | null
  /** Its agent is running, or starting. */
  running: boolean
  /** The agent answers `/mcp` itself. */
  manages: boolean
}

type RowStatus = 'not-started' | 'unreported'

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
      if (launch.running) {
        return answer
      }
      const taken = new Set(answer.servers.map(({ name }) => name))
      return { ...answer, servers: [...answer.servers, ...(await orcaRows(launch, taken))] }
    }
    const listsNothing = answer.status === 'unsupported' && !launch.manages
    if (answer.status !== 'not-running' && !listsNothing) {
      return answer
    }
    const resting = answer.status === 'not-running' || !launch.running
    const servers = await knownRows(launch, resting ? 'not-started' : 'unreported')
    return { status: resting ? 'not-running' : 'ok', servers }
  } catch (error) {
    console.warn('[mcp-servers] the chat’s servers could not be read', error)
  }
  return answer
}

async function knownRows(
  launch: KnownMcpLaunch,
  status: RowStatus
): Promise<AgentSessionMcpServer[]> {
  const env =
    launch.agent === 'claude' && launch.accountHome
      ? { ...process.env, ...claudeConfigDirEnvPatch(launch.accountHome) }
      : process.env
  const config = await agentOwnMcpConfig(launch.agent, env, await launch.cwd())
  const orca = await orcaRows(launch, new Set(config.names), new Set(config.bridged), status)
  // One row per file entry, Orca's own bridges left out (they show under Orca).
  const own = new Map<string, AgentSessionMcpServer>()
  for (const entry of config.entries) {
    if (!config.orcaOwned.has(entry.name)) {
      const disabled = entry.disabled || config.folderDisabled.has(entry.name)
      own.set(
        `${entry.scope}\0${entry.projectPath ?? ''}\0${entry.name}`,
        ownRow(launch.agent, entry, disabled ? 'disabled' : status)
      )
    }
  }
  return [...orca, ...own.values()]
}

/**
 * The host list's servers the chat gets: those `taken` by the agent's own names are skipped, as
 * delivery skips them, and those `bridged` reach it through Orca's entries in its own files. A
 * running agent has what its launch delivered.
 */
async function orcaRows(
  launch: KnownMcpLaunch,
  taken: ReadonlySet<string>,
  bridged: ReadonlySet<string> = new Set(),
  status: RowStatus = 'not-started'
): Promise<AgentSessionMcpServer[]> {
  const delivered = launch.running ? sessionHostMcpDelivered(launch.sessionId) : undefined
  // Its settings refuse them, it ignores a session's servers, or its launch got none.
  if (
    delivered === 'ignored' ||
    (delivered?.size === 0 && bridged.size === 0) ||
    isMcpAgentBlocked(launch.agent) ||
    acpLaunchSpecFor(launch.agent)?.botToolsOff
  ) {
    return []
  }
  const folder = mcpHostListFolder()
  const key = mcpServerWorkspaceKeyOf(launch.workspaceId)
  const { servers } = await mcpServersForLaunch(launch.agent, { key }, folder)
  // A running agent keeps what it launched with until it restarts, whatever the list says now.
  const names = delivered
    ? [...new Set([...delivered, ...bridged])]
    : servers.flatMap(({ name }) => (!taken.has(name) || bridged.has(name) ? [name] : []))
  const shown = new Set(names)
  // Sign-ins read for the rows shown only: each one opens a sealed entry.
  const signIns = new Map(
    botOwnTools(
      servers.filter(({ name }) => shown.has(name)),
      folder
    ).map(({ name, signIn }) => [name, signIn])
  )
  return names.map((name) => {
    const signIn = signIns.get(name)
    return row(
      name,
      ORCA_MCP_SOURCE,
      signIn && signIn.state !== 'signed-in' ? 'needs-auth' : status
    )
  })
}

function ownRow(
  agent: string,
  { name, scope, projectPath }: AgentMcpConfigName,
  status: AgentSessionMcpServerStatus
): AgentSessionMcpServer {
  // Claude keeps a folder's own servers in its user file: its `/mcp` calls them local.
  const source =
    scope === 'project' ? 'project' : agent === 'claude' && projectPath ? 'local' : 'user'
  return row(name, source, status)
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

// The names an agent already uses for MCP servers in its own config (its user files and the
// launch folder's), which a server from the host's list must not take: Codex merges the two
// entries, and others replace or shadow one with the other.
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { getAppEnvironment, hasAppEnvironment } from '../../shared/app-lifecycle/app-environment'
import {
  readAgentMcpServerNames,
  type AgentMcpConfigName
} from './agent-configs/agent-mcp-config-read'
import { isOrcaOwnedAgentMcpServer } from '../../shared/mcp/agent-mcp-config-entry'
import { mcpHostServerNameOfEntry } from './agent-files/mcp-agent-file-entry'
import { MCP_CONFIG_AGENTS, type McpConfigAgent } from './agent-configs/agent-mcp-config-locations'

/** A chat agent whose config is another agent's files. */
const CONFIG_AGENT_OF: Readonly<Record<string, McpConfigAgent>> = { opencode2: 'opencode' }

const configAgentOf = (agent: string): McpConfigAgent | null =>
  CONFIG_AGENT_OF[agent] ?? MCP_CONFIG_AGENTS.find((known) => known === agent) ?? null

export type AgentOwnMcpConfig = {
  /** Names the agent's files hold here, readable entries or not; a name may repeat. */
  names: string[]
  /** Host-list servers Orca's own bridge entries in its files already serve. */
  bridged: string[]
  /** Each entry here, Orca's own bridges among them (`orcaOwned`). */
  entries: AgentMcpConfigName[]
  /** Names of Orca's own bridge entries here. */
  orcaOwned: ReadonlySet<string>
  /** Names switched off in this folder whatever file defines them. */
  folderDisabled: ReadonlySet<string>
}

const NO_CONFIG: AgentOwnMcpConfig = {
  names: [],
  bridged: [],
  entries: [],
  orcaOwned: new Set(),
  folderDisabled: new Set()
}

export async function agentOwnMcpServerNames(
  agent: string,
  env: NodeJS.ProcessEnv,
  cwd: string
): Promise<string[]> {
  const { names, bridged } = await agentOwnMcpConfig(agent, env, cwd)
  return [...new Set([...names, ...bridged])]
}

/** What `agent` loads from its user files and `cwd`'s (none of a folder's with a null `cwd`). */
export async function agentOwnMcpConfig(
  agent: string,
  env: NodeJS.ProcessEnv,
  cwd: string | null
): Promise<AgentOwnMcpConfig> {
  const configAgent = configAgentOf(agent)
  if (!configAgent) {
    return NO_CONFIG
  }
  const context = { homeDir: homedir(), env, platform: process.platform }
  const inFolder = ({ projectPath }: { projectPath?: string }): boolean =>
    !projectPath || (cwd !== null && resolve(projectPath) === resolve(cwd))
  // Every name the agent's files hold is taken, even one whose entry Orca can't read: Codex would
  // merge a same-named server into it. The agent loads Orca's own bridge entries too: one this Orca
  // keeps for a server (Grok's, Cursor's and Droid's files) already serves it, so the session isn't
  // given it a second time.
  // Claude's user file holds a block per folder it ever opened; only this one's is read.
  const { names, servers, folderDisabled } = await readAgentMcpServerNames(configAgent, context, {
    ...(cwd === null ? {} : { projectPath: cwd }),
    skipProject: (projectPath) => !inFolder({ projectPath })
  })
  const userDataPath = hasAppEnvironment() ? getAppEnvironment().getPath('userData') : null
  const bridged: string[] = []
  const orcaOwned = new Set<string>()
  for (const { configName, server, source } of servers) {
    if (!inFolder(source) || !isOrcaOwnedAgentMcpServer(server)) {
      continue
    }
    orcaOwned.add(configName)
    const hostName =
      userDataPath && !('url' in server)
        ? mcpHostServerNameOfEntry(configName, server.env, userDataPath)
        : null
    if (hostName && hostName !== configName) {
      bridged.push(hostName)
    }
  }
  const entries = names.filter(inFolder)
  return {
    names: entries.map(({ name }) => name),
    bridged,
    entries,
    orcaOwned,
    folderDisabled
  }
}

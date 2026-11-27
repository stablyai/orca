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
  /** Names the agent's files hold here, readable entries or not. */
  names: string[]
  /** Host-list servers Orca's own bridge entries in its files already serve. */
  bridged: string[]
  /** The agent's own servers here, Orca's bridges left out, as its `/mcp` would list them. */
  own: AgentMcpConfigName[]
}

const NO_CONFIG: AgentOwnMcpConfig = { names: [], bridged: [], own: [] }

const entryKey = (name: string, scope: string, projectPath: string | undefined): string =>
  JSON.stringify([scope, projectPath ?? null, name])

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
  const { names, servers } = await readAgentMcpServerNames(configAgent, context, {
    ...(cwd === null ? {} : { projectPath: cwd }),
    skipProject: (projectPath) => !inFolder({ projectPath })
  })
  const userDataPath = hasAppEnvironment() ? getAppEnvironment().getPath('userData') : null
  const here = servers.filter(({ source }) => inFolder(source))
  const bridged = here.flatMap(({ configName, server }) => {
    const hostName =
      userDataPath && !('url' in server)
        ? mcpHostServerNameOfEntry(configName, server.env, userDataPath)
        : null
    return hostName && hostName !== configName ? [hostName] : []
  })
  const parsed = new Map(
    here.map((entry) => [
      entryKey(entry.configName, entry.source.scope, entry.source.projectPath),
      entry
    ])
  )
  const own = new Map<string, AgentMcpConfigName>()
  for (const entry of names.filter(inFolder)) {
    const key = entryKey(entry.name, entry.scope, entry.projectPath)
    const server = parsed.get(key)
    if (!server || !isOrcaOwnedAgentMcpServer(server.server)) {
      own.set(key, { ...entry, disabled: entry.disabled || server?.source.disabled === true })
    }
  }
  return {
    names: [...new Set(names.filter(inFolder).map(({ name }) => name))],
    bridged,
    own: [...own.values()]
  }
}

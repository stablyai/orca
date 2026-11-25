// The names an agent already uses for MCP servers in its own config (its user files and the
// launch folder's), which a server from the host's list must not take: Codex merges the two
// entries, and others replace or shadow one with the other.
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { getAppEnvironment, hasAppEnvironment } from '../../shared/app-lifecycle/app-environment'
import { readAgentMcpServerNames, readAgentMcpServers } from './agent-configs/agent-mcp-config-read'
import { mcpHostServerNameOfEntry } from './agent-files/mcp-agent-file-entry'
import { MCP_CONFIG_AGENTS, type McpConfigAgent } from './agent-configs/agent-mcp-config-locations'

/** A chat agent whose config is another agent's files. */
const CONFIG_AGENT_OF: Readonly<Record<string, McpConfigAgent>> = { opencode2: 'opencode' }

const configAgentOf = (agent: string): McpConfigAgent | null =>
  CONFIG_AGENT_OF[agent] ?? MCP_CONFIG_AGENTS.find((known) => known === agent) ?? null

export async function agentOwnMcpServerNames(
  agent: string,
  env: NodeJS.ProcessEnv,
  cwd: string
): Promise<string[]> {
  const configAgent = configAgentOf(agent)
  if (!configAgent) {
    return []
  }
  const context = { homeDir: homedir(), env, platform: process.platform }
  const inFolder = ({ projectPath }: { projectPath?: string }): boolean =>
    !projectPath || resolve(projectPath) === resolve(cwd)
  // Every name the agent's files hold is taken, even one whose entry Orca can't read: Codex would
  // merge a same-named server into it.
  const [names, servers] = await Promise.all([
    readAgentMcpServerNames(configAgent, context, { projectPath: cwd }),
    // The agent loads Orca's own bridge entries too: one this Orca keeps for a server (Grok's,
    // Cursor's and Droid's files) already serves it, so the session isn't given it a second time.
    readAgentMcpServers(configAgent, context, { projectPath: cwd, withOrcaOwned: true })
  ])
  const userDataPath = hasAppEnvironment() ? getAppEnvironment().getPath('userData') : null
  const bridged = servers
    .filter(({ source }) => inFolder(source))
    .flatMap(({ configName, server }) => {
      const hostName =
        userDataPath && !('url' in server)
          ? mcpHostServerNameOfEntry(configName, server.env, userDataPath)
          : null
      return hostName && hostName !== configName ? [hostName] : []
    })
  return [...new Set([...names.filter(inFolder).map(({ name }) => name), ...bridged])]
}

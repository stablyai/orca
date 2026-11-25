// The names an agent already uses for MCP servers in its own config (its user files and the
// launch folder's), which a server from the host's list must not take: Codex merges the two
// entries, and others replace or shadow one with the other.
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { readAgentMcpServers } from './agent-configs/agent-mcp-config-read'
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
  const servers = await readAgentMcpServers(
    configAgent,
    { homeDir: homedir(), env, platform: process.platform },
    { projectPath: cwd }
  )
  return servers
    .filter(({ source }) => !source.projectPath || resolve(source.projectPath) === resolve(cwd))
    .map((server) => server.configName)
}

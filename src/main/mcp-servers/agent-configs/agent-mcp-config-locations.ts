// Where each agent keeps its own MCP servers on this host, and how each file spells them.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentMcpConfigDialect } from '../../../shared/mcp/agent-mcp-config-entry'
import { resolveClaudeGlobalConfigFile } from '../../claude/configuration/claude-folder-trust-file'
import { hasCustomCodexHomeOverride } from '../../codex/configuration/homes/codex-real-home-path'

/** The agents whose own MCP config Orca reads, in the order merged rows name them. */
export const MCP_CONFIG_AGENTS = [
  'claude',
  'codex',
  'opencode',
  'gemini',
  'copilot',
  'pi',
  'grok',
  'cursor',
  'droid',
  'amp'
] as const
export type McpConfigAgent = (typeof MCP_CONFIG_AGENTS)[number]

export type AgentMcpConfigLocation = {
  agent: McpConfigAgent
  path: string
  format: 'json' | 'toml'
  /** A repo's own file is shared with the team, so Orca never moves servers out of it. */
  scope: 'user' | 'project'
}

export type AgentMcpConfigContext = {
  homeDir: string
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
}

const envDir = (env: NodeJS.ProcessEnv, name: string): string | undefined =>
  env[name]?.trim() || undefined

/** Codex's own home: a CODEX_HOME the user set, never one Orca launched this process with. */
export function codexSourceHome(context: AgentMcpConfigContext): string {
  return hasCustomCodexHomeOverride(context.env) && context.env.CODEX_HOME
    ? context.env.CODEX_HOME.trim()
    : join(context.homeDir, '.codex')
}

const xdgConfigHome = (context: AgentMcpConfigContext): string =>
  envDir(context.env, 'XDG_CONFIG_HOME') ?? join(context.homeDir, '.config')

function userFiles(agent: McpConfigAgent, context: AgentMcpConfigContext): string[] {
  const { homeDir, env } = context
  switch (agent) {
    case 'claude':
      return [
        resolveClaudeGlobalConfigFile({
          env: { CLAUDE_CONFIG_DIR: envDir(env, 'CLAUDE_CONFIG_DIR') },
          homeDir,
          style: context.platform === 'win32' ? 'win32' : 'posix',
          exists: existsSync
        })
      ]
    case 'codex':
      return [join(codexSourceHome(context), 'config.toml')]
    case 'opencode': {
      const dir = join(xdgConfigHome(context), 'opencode')
      const explicit = envDir(env, 'OPENCODE_CONFIG')
      return [
        join(dir, 'opencode.json'),
        join(dir, 'opencode.jsonc'),
        ...(explicit ? [explicit] : [])
      ]
    }
    case 'gemini':
      return [join(homeDir, '.gemini', 'settings.json')]
    case 'copilot':
      return [join(envDir(env, 'COPILOT_HOME') ?? join(homeDir, '.copilot'), 'mcp-config.json')]
    case 'pi':
      return [join(envDir(env, 'PI_CODING_AGENT_DIR') ?? join(homeDir, '.pi', 'agent'), 'mcp.json')]
    case 'grok':
      return [join(envDir(env, 'GROK_HOME') ?? join(homeDir, '.grok'), 'config.toml')]
    case 'cursor':
      return [join(homeDir, '.cursor', 'mcp.json')]
    case 'droid':
      return [join(homeDir, '.factory', 'mcp.json')]
    case 'amp':
      return [join(xdgConfigHome(context), 'amp', 'settings.json')]
  }
}

function projectFiles(agent: McpConfigAgent, projectPath: string): string[] {
  switch (agent) {
    case 'claude':
      return [join(projectPath, '.mcp.json')]
    case 'codex':
      return [join(projectPath, '.codex', 'config.toml')]
    case 'opencode':
      return ['opencode.json', 'opencode.jsonc'].flatMap((name) => [
        join(projectPath, name),
        join(projectPath, '.opencode', name)
      ])
    case 'gemini':
      return [join(projectPath, '.gemini', 'settings.json')]
    case 'pi':
      return [join(projectPath, '.pi', 'mcp.json')]
    case 'grok':
      return [join(projectPath, '.grok', 'config.toml')]
    case 'cursor':
      return [join(projectPath, '.cursor', 'mcp.json')]
    case 'droid':
      return [join(projectPath, '.factory', 'mcp.json')]
    case 'copilot':
    case 'amp':
      return []
  }
}

/** The agent's user files, plus its files in `projectPath`'s repo when one is given. */
export function agentMcpConfigLocations(
  agent: McpConfigAgent,
  context: AgentMcpConfigContext,
  projectPath?: string
): AgentMcpConfigLocation[] {
  const format: AgentMcpConfigLocation['format'] =
    agent === 'codex' || agent === 'grok' ? 'toml' : 'json'
  return [
    ...userFiles(agent, context).map((path) => ({ agent, path, format, scope: 'user' as const })),
    ...(projectPath ? projectFiles(agent, projectPath) : []).map((path) => ({
      agent,
      path,
      format,
      scope: 'project' as const
    }))
  ]
}

export type AgentMcpServerBlock = {
  /** The key path of the object holding the servers, by name. */
  path: string[]
  dialect: AgentMcpConfigDialect
  /** Claude's per-project (local scope) servers in its user file. */
  projectPath?: string
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null
}

/** Where in a parsed file the servers sit; Claude's user file holds one block per project too. */
export function agentMcpServerBlocks(
  location: AgentMcpConfigLocation,
  parsed: Record<string, unknown>,
  skipProject: (projectPath: string) => boolean
): AgentMcpServerBlock[] {
  switch (location.agent) {
    case 'claude': {
      const user: AgentMcpServerBlock = { path: ['mcpServers'], dialect: 'mcp-json' }
      if (location.scope === 'project') {
        return [user]
      }
      const projects = Object.keys(record(parsed.projects) ?? {})
        .filter((projectPath) => !skipProject(projectPath))
        .map((projectPath) => ({
          path: ['projects', projectPath, 'mcpServers'],
          dialect: 'mcp-json' as const,
          projectPath
        }))
      return [user, ...projects]
    }
    case 'codex':
      return [{ path: ['mcp_servers'], dialect: 'codex-toml' }]
    case 'grok':
      return [{ path: ['mcp_servers'], dialect: 'grok-toml' }]
    case 'gemini':
      return [{ path: ['mcpServers'], dialect: 'gemini' }]
    case 'opencode': {
      // 2.x nests servers under `mcp.servers`; 1.x keys them straight under `mcp`, where a 1.x
      // server named "servers" still carries its own `type`.
      const servers = record(record(parsed.mcp)?.servers)
      return servers && typeof servers.type !== 'string'
        ? [{ path: ['mcp', 'servers'], dialect: 'opencode-v2' }]
        : [{ path: ['mcp'], dialect: 'opencode-v1' }]
    }
    case 'amp':
      return [{ path: ['amp.mcpServers'], dialect: 'mcp-json' }]
    default:
      return [{ path: ['mcpServers'], dialect: 'mcp-json' }]
  }
}

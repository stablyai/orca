import type { AgentType } from '../../shared/agent-status-types'
import type { AgentContextScope } from '../../shared/agent-context'
import type { McpConfigCandidate } from '../../shared/mcp-config'
import { MCP_CONFIG_CANDIDATES } from '../../shared/mcp-config'
import { defaultAgentContextPathApi, type AgentContextPathApi } from './agent-context-sources'

export type McpFileSource = {
  id: string
  path: string
  scope: AgentContextScope
  agents: AgentType[]
  candidate: McpConfigCandidate
  /** JSON files: additional object paths holding servers for this workspace
   *  (Claude keeps `claude mcp add` local-scope servers under `projects.<cwd>.mcpServers`). */
  extraServersPaths?: string[][]
  /** Codex `config.toml` declares servers as `[mcp_servers.<name>]` tables. */
  format?: 'json' | 'codex-toml'
}

export type SettingsFileSource = {
  id: string
  path: string
  scope: AgentContextScope
  agents: AgentType[]
}

const HOME_MCP_CANDIDATES: {
  candidate: McpConfigCandidate
  segments: string[]
  agents: AgentType[]
}[] = [
  {
    candidate: {
      format: 'claude',
      label: 'Claude user',
      relativePath: '.claude.json',
      serversPath: ['mcpServers']
    },
    segments: ['.claude.json'],
    agents: ['claude']
  },
  {
    candidate: {
      format: 'cursor',
      label: 'Cursor user',
      relativePath: '.cursor/mcp.json',
      serversPath: ['mcpServers']
    },
    segments: ['.cursor', 'mcp.json'],
    agents: ['cursor']
  },
  {
    candidate: {
      format: 'workspace',
      label: 'Gemini user',
      relativePath: '.gemini/settings.json',
      serversPath: ['mcpServers']
    },
    segments: ['.gemini', 'settings.json'],
    agents: ['gemini']
  }
]

const OPENCODE_MCP_CANDIDATE: McpConfigCandidate = {
  format: 'workspace',
  label: 'OpenCode',
  relativePath: 'opencode.json',
  serversPath: ['mcp']
}

const CODEX_MCP_CANDIDATE: McpConfigCandidate = {
  format: 'workspace',
  label: 'Codex',
  relativePath: '.codex/config.toml',
  serversPath: ['mcp_servers']
}

function agentsForMcpCandidate(candidate: McpConfigCandidate): AgentType[] {
  switch (candidate.format) {
    case 'cursor':
      return ['cursor']
    case 'claude':
      return ['claude']
    default:
      // `.mcp.json` is Claude's project-scope file; other agents read it via plugins only.
      return ['claude']
  }
}

export function buildMcpFileSources(args: {
  homeDir: string
  cwd: string | null
  pathApi?: AgentContextPathApi
}): McpFileSource[] {
  const pathApi = args.pathApi ?? defaultAgentContextPathApi
  const sources: McpFileSource[] = HOME_MCP_CANDIDATES.map((entry) => ({
    id: `home-mcp:${entry.candidate.relativePath}`,
    path: pathApi.join(args.homeDir, ...entry.segments),
    scope: 'home',
    agents: [...entry.agents],
    candidate: entry.candidate,
    extraServersPaths:
      entry.candidate.relativePath === '.claude.json' && args.cwd
        ? [['projects', args.cwd, 'mcpServers']]
        : undefined
  }))
  sources.push(
    {
      id: 'home-mcp:.codex/config.toml',
      path: pathApi.join(args.homeDir, '.codex', 'config.toml'),
      scope: 'home',
      agents: ['codex'],
      candidate: CODEX_MCP_CANDIDATE,
      format: 'codex-toml'
    },
    {
      id: 'home-mcp:opencode.json',
      path: pathApi.join(args.homeDir, '.config', 'opencode', 'opencode.json'),
      scope: 'home',
      agents: ['opencode'],
      candidate: OPENCODE_MCP_CANDIDATE
    }
  )
  if (!args.cwd) {
    return sources
  }
  for (const candidate of MCP_CONFIG_CANDIDATES) {
    sources.push({
      id: `project-mcp:${candidate.relativePath}`,
      path: pathApi.join(args.cwd, ...candidate.relativePath.split('/')),
      scope: 'project',
      agents: agentsForMcpCandidate(candidate),
      candidate
    })
  }
  sources.push(
    {
      id: 'project-mcp:.codex/config.toml',
      path: pathApi.join(args.cwd, '.codex', 'config.toml'),
      scope: 'project',
      agents: ['codex'],
      candidate: CODEX_MCP_CANDIDATE,
      format: 'codex-toml'
    },
    {
      id: 'project-mcp:opencode.json',
      path: pathApi.join(args.cwd, 'opencode.json'),
      scope: 'project',
      agents: ['opencode'],
      candidate: OPENCODE_MCP_CANDIDATE
    }
  )
  return sources
}

/** Claude merges user, project, then project-local settings — hooks and enabledPlugins live here. */
export function buildClaudeSettingsSources(args: {
  homeDir: string
  cwd: string | null
  pathApi?: AgentContextPathApi
}): SettingsFileSource[] {
  const pathApi = args.pathApi ?? defaultAgentContextPathApi
  const sources: SettingsFileSource[] = [
    {
      id: 'home-claude-settings',
      path: pathApi.join(args.homeDir, '.claude', 'settings.json'),
      scope: 'home',
      agents: ['claude']
    }
  ]
  if (args.cwd) {
    sources.push(
      {
        id: 'project-claude-settings',
        path: pathApi.join(args.cwd, '.claude', 'settings.json'),
        scope: 'project',
        agents: ['claude']
      },
      {
        id: 'project-claude-settings-local',
        path: pathApi.join(args.cwd, '.claude', 'settings.local.json'),
        scope: 'project',
        agents: ['claude']
      }
    )
  }
  return sources
}

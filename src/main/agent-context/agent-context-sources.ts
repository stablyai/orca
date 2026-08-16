import { basename, dirname, join, type posix } from 'node:path'
import type { AgentType } from '../../shared/agent-status-types'
import type { AgentContextScope } from '../../shared/agent-context'
import type { McpConfigCandidate } from '../../shared/mcp-config'
import { MCP_CONFIG_CANDIDATES } from '../../shared/mcp-config'

export type AgentContextPathApi = Pick<typeof posix, 'basename' | 'dirname' | 'join'>

export type InstructionFileSource = {
  id: string
  label: string
  path: string
  scope: AgentContextScope
  agents: AgentType[]
  /** Directory sources count their rule files instead of reporting a size. */
  kind: 'file' | 'directory'
}

export type McpFileSource = {
  id: string
  path: string
  scope: AgentContextScope
  agents: AgentType[]
  candidate: McpConfigCandidate
}

export type SettingsFileSource = {
  id: string
  path: string
  scope: AgentContextScope
  agents: AgentType[]
}

const defaultPathApi: AgentContextPathApi = { basename, dirname, join }

// Why: capped so a workspace nested deep under `/` cannot fan out into an
// unbounded stat walk; agents themselves stop at the repo or home boundary.
export const MAX_ANCESTOR_LEVELS = 8

/** Agents that read a shared `AGENTS.md` at the workspace root and its ancestors. */
export const AGENTS_MD_READERS: AgentType[] = [
  'codex',
  'opencode',
  'amp',
  'cursor',
  'copilot',
  'pi'
]

function ancestorDirs(cwd: string, pathApi: AgentContextPathApi): string[] {
  const dirs: string[] = []
  let current = cwd
  for (let level = 0; level < MAX_ANCESTOR_LEVELS; level += 1) {
    const parent = pathApi.dirname(current)
    if (!parent || parent === current) {
      break
    }
    dirs.push(parent)
    current = parent
  }
  return dirs
}

/**
 * Every instruction file a supported agent loads for a session rooted at `cwd`.
 * The table is the product: each row names the agents that read the path so the
 * panel can group by agent without re-deriving vendor conventions.
 */
export function buildInstructionFileSources(args: {
  homeDir: string
  cwd: string | null
  pathApi?: AgentContextPathApi
}): InstructionFileSource[] {
  const pathApi = args.pathApi ?? defaultPathApi
  const { homeDir, cwd } = args
  const sources: InstructionFileSource[] = [
    {
      id: 'home-claude-md',
      label: 'CLAUDE.md',
      path: pathApi.join(homeDir, '.claude', 'CLAUDE.md'),
      scope: 'home',
      agents: ['claude'],
      kind: 'file'
    },
    {
      id: 'home-codex-agents-md',
      label: 'AGENTS.md',
      path: pathApi.join(homeDir, '.codex', 'AGENTS.md'),
      scope: 'home',
      agents: ['codex'],
      kind: 'file'
    },
    {
      id: 'home-gemini-md',
      label: 'GEMINI.md',
      path: pathApi.join(homeDir, '.gemini', 'GEMINI.md'),
      scope: 'home',
      agents: ['gemini'],
      kind: 'file'
    },
    {
      id: 'home-opencode-agents-md',
      label: 'AGENTS.md',
      path: pathApi.join(homeDir, '.config', 'opencode', 'AGENTS.md'),
      scope: 'home',
      agents: ['opencode'],
      kind: 'file'
    }
  ]
  if (!cwd) {
    return sources
  }
  sources.push(
    {
      id: 'project-claude-md',
      label: 'CLAUDE.md',
      path: pathApi.join(cwd, 'CLAUDE.md'),
      scope: 'project',
      agents: ['claude'],
      kind: 'file'
    },
    {
      id: 'project-claude-local-md',
      label: 'CLAUDE.local.md',
      path: pathApi.join(cwd, 'CLAUDE.local.md'),
      scope: 'project',
      agents: ['claude'],
      kind: 'file'
    },
    {
      id: 'project-dot-claude-md',
      label: '.claude/CLAUDE.md',
      path: pathApi.join(cwd, '.claude', 'CLAUDE.md'),
      scope: 'project',
      agents: ['claude'],
      kind: 'file'
    },
    {
      id: 'project-agents-md',
      label: 'AGENTS.md',
      path: pathApi.join(cwd, 'AGENTS.md'),
      scope: 'project',
      agents: [...AGENTS_MD_READERS],
      kind: 'file'
    },
    {
      id: 'project-gemini-md',
      label: 'GEMINI.md',
      path: pathApi.join(cwd, 'GEMINI.md'),
      scope: 'project',
      agents: ['gemini'],
      kind: 'file'
    },
    {
      id: 'project-cursorrules',
      label: '.cursorrules',
      path: pathApi.join(cwd, '.cursorrules'),
      scope: 'project',
      agents: ['cursor'],
      kind: 'file'
    },
    {
      id: 'project-cursor-rules-dir',
      label: '.cursor/rules/',
      path: pathApi.join(cwd, '.cursor', 'rules'),
      scope: 'project',
      agents: ['cursor'],
      kind: 'directory'
    },
    {
      id: 'project-copilot-instructions',
      label: '.github/copilot-instructions.md',
      path: pathApi.join(cwd, '.github', 'copilot-instructions.md'),
      scope: 'project',
      agents: ['copilot'],
      kind: 'file'
    },
    {
      id: 'project-copilot-instructions-dir',
      label: '.github/instructions/',
      path: pathApi.join(cwd, '.github', 'instructions'),
      scope: 'project',
      agents: ['copilot'],
      kind: 'directory'
    }
  )
  // Why: Claude and Codex both walk up from cwd, so a monorepo root file
  // applies to a nested workspace even though it is outside the worktree.
  for (const dir of ancestorDirs(cwd, pathApi)) {
    if (dir === homeDir) {
      break
    }
    sources.push(
      {
        id: `ancestor-claude-md:${dir}`,
        label: 'CLAUDE.md',
        path: pathApi.join(dir, 'CLAUDE.md'),
        scope: 'ancestor',
        agents: ['claude'],
        kind: 'file'
      },
      {
        id: `ancestor-agents-md:${dir}`,
        label: 'AGENTS.md',
        path: pathApi.join(dir, 'AGENTS.md'),
        scope: 'ancestor',
        agents: [...AGENTS_MD_READERS],
        kind: 'file'
      }
    )
  }
  return sources
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
  const pathApi = args.pathApi ?? defaultPathApi
  const sources: McpFileSource[] = HOME_MCP_CANDIDATES.map((entry) => ({
    id: `home-mcp:${entry.candidate.relativePath}`,
    path: pathApi.join(args.homeDir, ...entry.segments),
    scope: 'home',
    agents: [...entry.agents],
    candidate: entry.candidate
  }))
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
  return sources
}

/** Claude merges user, project, then project-local settings — hooks and enabledPlugins live here. */
export function buildClaudeSettingsSources(args: {
  homeDir: string
  cwd: string | null
  pathApi?: AgentContextPathApi
}): SettingsFileSource[] {
  const pathApi = args.pathApi ?? defaultPathApi
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

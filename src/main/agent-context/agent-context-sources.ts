import { basename, dirname, join, type posix } from 'node:path'
import type { AgentType } from '../../shared/agent-status-types'
import type { AgentContextScope } from '../../shared/agent-context'

export type AgentContextPathApi = Pick<typeof posix, 'basename' | 'dirname' | 'join'>

export const defaultAgentContextPathApi: AgentContextPathApi = { basename, dirname, join }

export type InstructionFileSource = {
  id: string
  label: string
  path: string
  scope: AgentContextScope
  agents: AgentType[]
  /** Directory sources count their rule files instead of reporting a size. */
  kind: 'file' | 'directory'
}

// Why: capped so a workspace nested deep under `/` cannot fan out into an
// unbounded stat walk; agents themselves stop at the repo or home boundary.
export const MAX_ANCESTOR_LEVELS = 8

/** Agents that read a shared `AGENTS.md` at the workspace root. */
export const AGENTS_MD_READERS: AgentType[] = [
  'codex',
  'opencode',
  'amp',
  'cursor',
  'copilot',
  'pi'
]

/**
 * Agents that also read `AGENTS.md` from parent folders, up to the git root.
 * Cursor and Copilot read only the workspace root's file.
 */
export const AGENTS_MD_ANCESTOR_READERS: AgentType[] = ['codex', 'opencode', 'amp', 'pi']

const WINDOWS_PATH_PATTERN = /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/])/

/** Path equality the way the host's filesystem sees it: Windows paths ignore case and separator style. */
export function isSamePath(a: string, b: string): boolean {
  const normalize = (value: string): string => {
    const unified = value.replace(/\\/g, '/').replace(/\/+$/, '')
    return WINDOWS_PATH_PATTERN.test(value) ? unified.toLowerCase() : unified
  }
  return normalize(a) === normalize(b)
}

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
 *
 * `gitRootDir` is the workspace's repository root (the nearest ancestor with a
 * `.git`), or `null` when there is none: Codex-family agents stop their
 * `AGENTS.md` walk there, Claude walks every parent up to the home directory.
 */
export function buildInstructionFileSources(args: {
  homeDir: string
  cwd: string | null
  gitRootDir?: string | null
  pathApi?: AgentContextPathApi
}): InstructionFileSource[] {
  const pathApi = args.pathApi ?? defaultAgentContextPathApi
  const { homeDir, cwd } = args
  const gitRootDir = args.gitRootDir ?? null
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
  // Why: Claude walks up from cwd to home, so a monorepo root file applies to a
  // nested workspace even though it is outside the worktree; Codex-family
  // agents walk only as far as the repository root.
  let insideGitRoot = gitRootDir !== null && !isSamePath(cwd, gitRootDir)
  for (const dir of ancestorDirs(cwd, pathApi)) {
    if (isSamePath(dir, homeDir)) {
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
        id: `ancestor-claude-local-md:${dir}`,
        label: 'CLAUDE.local.md',
        path: pathApi.join(dir, 'CLAUDE.local.md'),
        scope: 'ancestor',
        agents: ['claude'],
        kind: 'file'
      }
    )
    if (insideGitRoot) {
      sources.push({
        id: `ancestor-agents-md:${dir}`,
        label: 'AGENTS.md',
        path: pathApi.join(dir, 'AGENTS.md'),
        scope: 'ancestor',
        agents: [...AGENTS_MD_ANCESTOR_READERS],
        kind: 'file'
      })
      insideGitRoot = gitRootDir !== null && !isSamePath(dir, gitRootDir)
    }
  }
  return sources
}

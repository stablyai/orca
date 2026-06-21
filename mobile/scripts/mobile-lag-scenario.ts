import type {
  RuntimeWorktreeAgentRow,
  RuntimeWorktreePsSummary
} from '../../src/shared/runtime-types'

export type MockRepo = {
  id: string
  displayName: string
  path: string
  badgeColor: string
  connectionId: string | null
}

const REPO_COLORS = ['#f97316', '#8b5cf6', '#06b6d4', '#ec4899', '#84cc16', '#f59e0b', '#6366f1']
const REPO_NAMES = ['orca', 'dashboard', 'mobile', 'runtime', 'docs', 'api', 'desktop', 'site']
const WORKTREE_NAMES = ['manta', 'narwhal', 'otter', 'squid', 'turtle', 'beluga', 'marlin', 'orca']

export function readScenarioNumber(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) {
    return fallback
  }
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback
}

export function createMockRepos(count: number): MockRepo[] {
  return Array.from({ length: count }, (_, index) => {
    const repoName = REPO_NAMES[index % REPO_NAMES.length]!
    const suffix = index < REPO_NAMES.length ? '' : `-${Math.floor(index / REPO_NAMES.length) + 1}`
    const displayName = `${repoName}${suffix}`
    return {
      id: `repo-${index + 1}`,
      displayName,
      path: `/tmp/orca-mobile-repro/${displayName}`,
      badgeColor: REPO_COLORS[index % REPO_COLORS.length]!,
      connectionId: null
    }
  })
}

export function createMockWorktrees(
  repos: readonly MockRepo[],
  count: number,
  now = Date.now()
): RuntimeWorktreePsSummary[] {
  if (repos.length === 0) {
    return []
  }

  return Array.from({ length: count }, (_, index) => {
    const repo = repos[index % repos.length]!
    const name = `${WORKTREE_NAMES[index % WORKTREE_NAMES.length]}-${index + 1}`
    const status = index % 17 === 0 ? 'working' : index % 11 === 0 ? 'done' : 'active'
    const agents = index % 4 === 0 ? [createMockAgent(index, now)] : []
    const linkedPR =
      index % 9 === 0 ? { number: 1000 + index, state: index % 18 === 0 ? 'draft' : 'open' } : null

    return {
      worktreeId: `${repo.id}::${repo.path}/worktrees/${name}`,
      repoId: repo.id,
      repo: repo.displayName,
      path: `${repo.path}/worktrees/${name}`,
      branch: index % 6 === 0 ? 'main' : `feature/mobile-lag-${index + 1}`,
      isArchived: false,
      isMainWorktree: false,
      hasHostSidebarActivity: index % 5 !== 0,
      parentWorktreeId: null,
      childWorktreeIds: [],
      displayName: name,
      linkedIssue: index % 7 === 0 ? 200 + index : null,
      linkedPR,
      linkedLinearIssue: index % 13 === 0 ? `ORC-${index + 1}` : null,
      linkedGitLabMR: null,
      linkedGitLabIssue: null,
      comment: index % 10 === 0 ? `Mock workspace note ${index + 1}` : '',
      isPinned: index % 19 === 0,
      isActive: index === 0,
      unread: index % 8 === 0,
      liveTerminalCount: index % 5 === 0 ? 0 : 1 + (index % 3),
      hasAttachedPty: index % 5 !== 0,
      lastOutputAt: now - index * 23_000,
      preview: `$ pnpm test --filter mobile-${index + 1}`,
      status,
      agents
    }
  })
}

function createMockAgent(index: number, now: number): RuntimeWorktreeAgentRow {
  const scenarioTitle = `Investigate mobile lag scenario ${index + 1}`

  return {
    paneKey: `agent-${index}`,
    parentPaneKey: null,
    state: index % 12 === 0 ? 'waiting' : 'working',
    agentType: index % 3 === 0 ? 'claude' : 'codex',
    prompt: scenarioTitle,
    taskTitle: scenarioTitle,
    displayName: `Mobile lag ${index + 1}`,
    lastAssistantMessage: index % 6 === 0 ? 'Running focused checks' : null,
    toolName: null,
    toolInput: null,
    interrupted: false,
    stateStartedAt: now - index * 17_000,
    updatedAt: now - index * 11_000
  }
}

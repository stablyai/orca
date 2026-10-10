import { describe, expect, it } from 'vitest'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import { WORKSPACE_CLEANUP_STALE_AGENT_IDLE_MS } from '../../shared/workspace-cleanup'
import { createWorkspaceCleanupStaleAgentClassifier } from './workspace-cleanup-agent-scratch'

const NOW = 1_700_000_000_000
const REPO = { id: 'repo-1', path: '/repo' }
const SCRATCH_PATH = '/repo/.claude/worktrees/agent-a1b2'
const SCRATCH = {
  id: `repo-1::${SCRATCH_PATH}`,
  path: SCRATCH_PATH,
  isMainWorktree: false,
  lastActivityAt: NOW - WORKSPACE_CLEANUP_STALE_AGENT_IDLE_MS - 1
}
const GIT_WORKTREES = [
  { path: '/repo', isMainWorktree: true },
  { path: SCRATCH_PATH, isMainWorktree: false }
]

function liveRow(worktreeId: string, overrides: Partial<AgentStatusIpcPayload> = {}) {
  const row: AgentStatusIpcPayload = {
    state: 'working',
    prompt: '',
    agentType: 'claude',
    paneKey: 'tab-1:leaf-1',
    worktreeId,
    connectionId: null,
    receivedAt: Date.now(),
    stateStartedAt: Date.now(),
    ...overrides
  }
  return row
}

function classify(rows: readonly AgentStatusIpcPayload[], worktree = SCRATCH): boolean {
  return createWorkspaceCleanupStaleAgentClassifier({
    repo: REPO,
    gitWorktrees: GIT_WORKTREES,
    readAgentStatusSnapshot: () => rows
  })(worktree, NOW)
}

describe('stale agent worktree signal', () => {
  it('flags an idle agent scratch worktree with no live agent', () => {
    expect(classify([])).toBe(true)
  })

  it('keeps it when the owning checkout has a live agent driving it', () => {
    expect(classify([liveRow('repo-1::/repo')])).toBe(false)
  })

  it('keeps it when an agent is live inside the scratch worktree itself', () => {
    expect(classify([liveRow(SCRATCH.id, { state: 'waiting' })])).toBe(false)
  })

  it('ignores finished and stale rows', () => {
    const staleAt = Date.now() - 2 * 60 * 60 * 1000
    expect(
      classify([
        liveRow('repo-1::/repo', { state: 'done' }),
        liveRow(SCRATCH.id, { receivedAt: staleAt, stateStartedAt: staleAt })
      ])
    ).toBe(true)
  })

  it('needs the idle threshold and observed activity', () => {
    expect(classify([], { ...SCRATCH, lastActivityAt: NOW - 60_000 })).toBe(false)
    expect(classify([], { ...SCRATCH, lastActivityAt: 0 })).toBe(false)
  })

  it('treats a missing status store as unverifiable, never as idle', () => {
    const classifier = createWorkspaceCleanupStaleAgentClassifier({
      repo: REPO,
      gitWorktrees: GIT_WORKTREES
    })
    expect(classifier(SCRATCH, NOW)).toBe(false)
  })

  it('reuses the agent-scratch classifier instead of path guesses', () => {
    const lookalike = '/repo-feature/.claude/worktrees/agent-a1b2'
    expect(classify([], { ...SCRATCH, id: `repo-1::${lookalike}`, path: lookalike })).toBe(false)
    expect(classify([], { ...SCRATCH, isMainWorktree: true })).toBe(false)
    const configuredBase = createWorkspaceCleanupStaleAgentClassifier({
      repo: { ...REPO, worktreeBasePath: '.claude/worktrees' },
      gitWorktrees: GIT_WORKTREES,
      readAgentStatusSnapshot: () => []
    })
    expect(configuredBase(SCRATCH, NOW)).toBe(false)
  })

  it('recognizes the other built-in agent source', () => {
    const gsd = '/repo/.gsd-workspaces/task-1'
    expect(classify([], { ...SCRATCH, id: `repo-1::${gsd}`, path: gsd })).toBe(true)
  })
})

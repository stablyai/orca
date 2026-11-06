import { describe, expect, it } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../shared/constants'
import type { RuntimeWorktreePsSummary } from '../../shared/runtime-types'
import {
  FLOATING_WORKTREE_DISPLAY_NAME,
  FLOATING_WORKTREE_REPO_LABEL,
  pruneIdleFloatingWorktreePsSummary,
  seedFloatingWorktreePsSummary
} from './floating-worktree-ps-summary'
import type { RuntimeStore } from './runtime-store-contract'

function makeStoreStub(floatingTerminalCwd = '/home/aleksei'): RuntimeStore {
  return {
    getRepos: () => [],
    getRepo: () => undefined,
    addRepo: () => {
      throw new Error('unused')
    },
    updateRepo: () => null,
    getAllWorktreeMeta: () => ({}),
    getWorktreeMeta: () => undefined,
    setWorktreeMeta: () => ({}) as never,
    removeWorktreeMeta: () => undefined,
    getGitHubCache: () => ({ pr: {}, issue: {} }) as never,
    getSettings: () =>
      ({
        workspaceDir: '/tmp/workspaces',
        nestWorkspaces: false,
        refreshLocalBaseRefOnWorktreeCreate: false,
        branchPrefix: 'none',
        branchPrefixCustom: '',
        floatingTerminalCwd
      }) as ReturnType<RuntimeStore['getSettings']>
  }
}

describe('floating-worktree-ps-summary', () => {
  it('seeds and prunes an idle floating summary when no terminals or agents are active', () => {
    const summaries = new Map<string, RuntimeWorktreePsSummary>()
    seedFloatingWorktreePsSummary(summaries, makeStoreStub('/home/aleksei'))

    const seeded = summaries.get(FLOATING_TERMINAL_WORKTREE_ID)
    expect(seeded).toMatchObject({
      workspaceKind: 'floating',
      worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
      repoId: FLOATING_TERMINAL_WORKTREE_ID,
      hostId: 'local',
      repo: FLOATING_WORKTREE_REPO_LABEL,
      displayName: FLOATING_WORKTREE_DISPLAY_NAME,
      path: '/home/aleksei',
      liveTerminalCount: 0,
      agents: []
    })

    pruneIdleFloatingWorktreePsSummary(summaries)
    expect(summaries.has(FLOATING_TERMINAL_WORKTREE_ID)).toBe(false)
  })

  it('retains the floating summary when live terminals or agents are attached', () => {
    const summaries = new Map<string, RuntimeWorktreePsSummary>()
    seedFloatingWorktreePsSummary(summaries, makeStoreStub('/home/aleksei'))

    const floating = summaries.get(FLOATING_TERMINAL_WORKTREE_ID)!
    floating.agents.push({
      paneKey: 'tab-float:pane-1',
      parentPaneKey: null,
      state: 'working',
      agentType: 'antigravity',
      prompt: 'Audit host setup',
      taskTitle: 'Audit host setup',
      displayName: null,
      lastAssistantMessage: null,
      toolName: 'run_command',
      toolInput: null,
      interrupted: false,
      stateStartedAt: 1_000,
      updatedAt: 2_000
    })

    pruneIdleFloatingWorktreePsSummary(summaries)
    expect(summaries.get(FLOATING_TERMINAL_WORKTREE_ID)?.agents).toHaveLength(1)
  })
})

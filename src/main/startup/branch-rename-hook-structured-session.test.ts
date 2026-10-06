import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionStatusSummary } from '../../shared/agent-session-wire'

// Why the mocks: this file only proves the structured-session seam, and the real orchestrator's
// import graph reaches git, electron, and the agent-hook installers.
const { renameCalls } = vi.hoisted(() => ({ renameCalls: [] as unknown[][] }))
vi.mock('../agent-hooks/first-work-branch-rename', () => ({
  maybeAutoRenameBranchOnFirstWork: (...args: unknown[]) => {
    renameCalls.push(args)
    return Promise.resolve()
  }
}))
vi.mock('../agent-hooks/branch-rename-failure-output', () => ({
  rememberBranchRenameFailureOutput: vi.fn()
}))
vi.mock('../agent-hooks/first-work-folder-rename', () => ({
  renameWorktreeFolderOnFirstWork: vi.fn()
}))
vi.mock('../git/worktree', () => ({ moveWorktree: vi.fn() }))
vi.mock('electron', () => ({ app: { getPath: () => '', on: vi.fn(), isReady: () => true } }))

import { maybeAutoRenameWorkspaceOnFirstStructuredTurn } from '../agent-hooks/first-work-structured-session-rename'
import { firstWorkRenameDeps } from '../agent-hooks/first-work-rename-runtime'
import { mainProcessState } from './main-process-state'

let renameDeps: ReturnType<typeof firstWorkRenameDeps>

const WORKSPACE_ID = 'repo1::/repo/wt'

function summary(overrides: Partial<AgentSessionStatusSummary> = {}): AgentSessionStatusSummary {
  return {
    sessionId: 'session-1',
    workspaceId: WORKSPACE_ID,
    agent: 'claude',
    status: 'working',
    latestPrompt: 'Fix the auth bug',
    updatedAt: 1,
    ...overrides
  }
}

beforeEach(() => {
  renameCalls.length = 0
  mainProcessState.store = {
    getSettings: () => ({}),
    getRepo: () => undefined,
    getWorktreeMeta: () => undefined,
    getWorktreeIdForTab: () => undefined
  } as unknown as typeof mainProcessState.store
  mainProcessState.runtime = {
    getCommitMessageAgentEnvironmentResolvers: () => undefined
  } as unknown as typeof mainProcessState.runtime
  renameDeps = firstWorkRenameDeps(mainProcessState.store!, mainProcessState.runtime!)
})

describe('maybeAutoRenameWorkspaceOnFirstStructuredTurn', () => {
  it('drives the first-work rename from the session workspace, with no pane to resolve', () => {
    maybeAutoRenameWorkspaceOnFirstStructuredTurn(summary(), { replay: false }, renameDeps)

    expect(renameCalls).toHaveLength(1)
    expect(renameCalls[0]?.[0]).toEqual({
      paneKey: '',
      tabId: undefined,
      worktreeId: WORKSPACE_ID,
      state: 'working',
      prompt: 'Fix the auth bug',
      assistantMessage: undefined,
      isReplay: false
    })
  })

  it('marks a re-projected summary as a replay so restore cannot rename on old state', () => {
    maybeAutoRenameWorkspaceOnFirstStructuredTurn(summary(), { replay: true }, renameDeps)

    expect(renameCalls[0]?.[0]).toMatchObject({ isReplay: true })
  })

  it('ignores every status that is not a running turn', () => {
    for (const status of ['idle', 'attention', null] as const) {
      maybeAutoRenameWorkspaceOnFirstStructuredTurn(
        summary({ status }),
        { replay: false },
        renameDeps
      )
    }

    expect(renameCalls).toEqual([])
  })

  it('uses the owning runtime even when desktop singletons do not exist', () => {
    mainProcessState.store = null
    mainProcessState.runtime = null
    maybeAutoRenameWorkspaceOnFirstStructuredTurn(summary(), { replay: false }, renameDeps)

    expect(renameCalls).toHaveLength(1)
    expect(renameCalls[0]?.[1]).toBe(renameDeps)
  })
})

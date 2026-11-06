import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  gitExecFileAsyncMock,
  generateBranchNameMock,
  resolveTextGenerationParamsMock,
  prepareLocalEnvMock,
  computeBranchNameMock
} = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn(),
  generateBranchNameMock: vi.fn(),
  resolveTextGenerationParamsMock: vi.fn(),
  prepareLocalEnvMock: vi.fn(async () => ({ ok: true as const })),
  computeBranchNameMock: vi.fn((leaf: string) => `you/${leaf}`)
}))

vi.mock('../git/command-runner/git-exec-file', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  gitExecFileAsync: gitExecFileAsyncMock
}))
vi.mock('../git/git-username', () => ({ resolveLocalGitUsername: vi.fn(async () => 'you') }))
vi.mock('../text-generation/commit-message-text-generation', () => ({
  generateBranchNameFromContext: generateBranchNameMock,
  resolveTextGenerationParams: resolveTextGenerationParamsMock
}))
vi.mock('../text-generation/commit-message-agent-environment', () => ({
  prepareLocalCommitMessageAgentEnv: prepareLocalEnvMock
}))
vi.mock('../ipc/worktree-branch-name', () => ({
  computeBranchName: computeBranchNameMock,
  getConfiguredBranchPrefix: vi.fn(() => 'you')
}))

import {
  maybeAutoRenameBranchOnFirstWork,
  resetFirstWorkBranchRenameState
} from './first-work-branch-rename'
import {
  REPO_ID,
  gitResponder,
  makeBranchRenameDeps,
  workingEvent
} from './first-work-branch-rename-test-harness'

function makeDeps(overrides: Parameters<typeof makeBranchRenameDeps>[1] = {}) {
  return makeBranchRenameDeps(vi.fn, overrides)
}

function onBranch(currentBranch: string, hasUpstream = false): void {
  gitExecFileAsyncMock.mockImplementation(gitResponder({ currentBranch, hasUpstream }))
}

describe('auto-rename for a branch named in a non-Latin script', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  beforeEach(() => {
    resetFirstWorkBranchRenameState()
    vi.clearAllMocks()
    computeBranchNameMock.mockImplementation((leaf: string) => `you/${leaf}`)
    prepareLocalEnvMock.mockResolvedValue({ ok: true })
    resolveTextGenerationParamsMock.mockReturnValue({
      ok: true,
      params: { agentId: 'claude', model: 'm' }
    })
    generateBranchNameMock.mockResolvedValue({ success: true, slug: 'fix-search-dialog-bug' })
  })

  it('renames a branch Orca folded from a non-Latin workspace name', async () => {
    onBranch('you/検索ダイアログのバグを修正')
    const { deps, onRenamed } = makeDeps({
      getCurrentDisplayName: () => '検索ダイアログのバグを修正'
    })
    await maybeAutoRenameBranchOnFirstWork(workingEvent(), deps)
    expect(generateBranchNameMock).toHaveBeenCalled()
    expect(onRenamed).toHaveBeenCalledWith(REPO_ID)
  })

  it('keeps the workspace label the user typed when it renames that branch', async () => {
    onBranch('you/検索ダイアログのバグを修正')
    const { deps, setDisplayName } = makeDeps({
      getCurrentDisplayName: () => '検索ダイアログのバグを修正'
    })
    await maybeAutoRenameBranchOnFirstWork(workingEvent(), deps)
    expect(setDisplayName).not.toHaveBeenCalled()
  })

  it('leaves the branch alone when creation recorded no name provenance', async () => {
    // Worktrees created before `branchNameWasExplicit` existed carry no flag,
    // and a missing flag is not evidence that Orca derived the name.
    onBranch('you/修正')
    const { deps, onRenamed } = makeDeps({
      isBranchNameDerived: () => false,
      getCurrentDisplayName: () => '修正'
    })
    await maybeAutoRenameBranchOnFirstWork(workingEvent(), deps)
    expect(generateBranchNameMock).not.toHaveBeenCalled()
    expect(onRenamed).not.toHaveBeenCalled()
  })

  it('still renames a creature branch with no recorded name provenance', async () => {
    onBranch('you/Nautilus')
    const { deps, onRenamed } = makeDeps({ isBranchNameDerived: () => false })
    await maybeAutoRenameBranchOnFirstWork(workingEvent(), deps)
    expect(generateBranchNameMock).toHaveBeenCalled()
    expect(onRenamed).toHaveBeenCalledWith(REPO_ID)
  })

  it('never rewrites a non-Latin branch that is already published', async () => {
    onBranch('you/検索ダイアログのバグを修正', true)
    const { deps, onRenamed } = makeDeps({
      getCurrentDisplayName: () => '検索ダイアログのバグを修正'
    })
    await maybeAutoRenameBranchOnFirstWork(workingEvent(), deps)
    expect(generateBranchNameMock).not.toHaveBeenCalled()
    expect(onRenamed).not.toHaveBeenCalled()
  })
})

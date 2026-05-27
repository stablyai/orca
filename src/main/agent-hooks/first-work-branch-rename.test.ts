/* eslint-disable max-lines -- Why: the orchestrator tests cover local, SSH,
   retry, and post-generation race guards; splitting would duplicate mocks. */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings, Repo } from '../../shared/types'
import { WORKTREE_ID_SEPARATOR } from '../../shared/worktree-id'

const {
  gitExecFileAsyncMock,
  getGitUsernameMock,
  getSshGitUsernameMock,
  getSshGitProviderMock,
  generateBranchNameMock,
  resolveTextGenerationParamsMock,
  prepareLocalEnvMock,
  computeBranchNameMock
} = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn(),
  getGitUsernameMock: vi.fn(() => 'you'),
  getSshGitUsernameMock: vi.fn(async () => 'you'),
  getSshGitProviderMock: vi.fn(() => undefined),
  generateBranchNameMock: vi.fn(),
  resolveTextGenerationParamsMock: vi.fn(),
  prepareLocalEnvMock: vi.fn(async () => ({ ok: true as const })),
  computeBranchNameMock: vi.fn((leaf: string) => `you/${leaf}`)
}))

vi.mock('../git/runner', () => ({ gitExecFileAsync: gitExecFileAsyncMock }))
vi.mock('../git/repo', () => ({ getGitUsername: getGitUsernameMock }))
vi.mock('../git/git-username', () => ({ getSshGitUsername: getSshGitUsernameMock }))
vi.mock('../providers/ssh-git-dispatch', () => ({ getSshGitProvider: getSshGitProviderMock }))
vi.mock('../text-generation/commit-message-text-generation', () => ({
  generateBranchNameFromContext: generateBranchNameMock,
  resolveTextGenerationParams: resolveTextGenerationParamsMock
}))
vi.mock('../text-generation/commit-message-agent-environment', () => ({
  prepareLocalCommitMessageAgentEnv: prepareLocalEnvMock
}))
vi.mock('../ipc/worktree-logic', () => ({ computeBranchName: computeBranchNameMock }))

import {
  maybeAutoRenameBranchOnFirstWork,
  resetFirstWorkBranchRenameState,
  type FirstWorkBranchRenameDeps,
  type FirstWorkBranchRenameEvent
} from './first-work-branch-rename'

const REPO_ID = 'repo1'
const WORKTREE_ID = `${REPO_ID}${WORKTREE_ID_SEPARATOR}/repo/wt`
const TAB_ID = 'tab-1'
const PANE_KEY = `${TAB_ID}:leaf-1`

const noUpstreamError = new Error("fatal: no upstream configured for branch 'Nautilus'")

function gitResponder(opts: {
  currentBranch: string
  hasUpstream: boolean
  existingRefs?: string[]
}) {
  return async (args: string[]) => {
    if (args[0] === 'rev-parse' && args.some((arg) => arg.includes('@{u}'))) {
      if (opts.hasUpstream) {
        return { stdout: 'origin/x\n', stderr: '' }
      }
      throw noUpstreamError
    }
    if (args[0] === 'rev-parse') {
      return { stdout: `${opts.currentBranch}\n`, stderr: '' }
    }
    if (args[0] === 'show-ref') {
      const ref = args.at(-1) ?? ''
      if ((opts.existingRefs ?? []).includes(ref)) {
        return { stdout: '', stderr: '' }
      }
      throw new Error('not found')
    }
    if (args[0] === 'branch' && args[1] === '-m') {
      return { stdout: '', stderr: '' }
    }
    throw new Error(`unexpected git args: ${args.join(' ')}`)
  }
}

function makeDeps(overrides: Partial<FirstWorkBranchRenameDeps> = {}): {
  deps: FirstWorkBranchRenameDeps
  onRenamed: ReturnType<typeof vi.fn>
  setDisplayName: ReturnType<typeof vi.fn>
} {
  const onRenamed = vi.fn()
  const setDisplayName = vi.fn()
  const settings = { autoRenameBranchFromWork: true } as unknown as GlobalSettings
  const repo = { id: REPO_ID, path: '/repo', connectionId: undefined } as unknown as Repo
  return {
    onRenamed,
    setDisplayName,
    deps: {
      getSettings: () => settings,
      getRepo: () => repo,
      getAgentEnvResolvers: () => undefined,
      getCurrentDisplayName: () => 'Nautilus-8',
      canRenameOrcaCreatedBranch: () => true,
      setDisplayName,
      resolveWorktreeIdForTab: () => WORKTREE_ID,
      onRenamed,
      ...overrides
    }
  }
}

function workingEvent(
  overrides: Partial<FirstWorkBranchRenameEvent> = {}
): FirstWorkBranchRenameEvent {
  return {
    paneKey: PANE_KEY,
    tabId: TAB_ID,
    worktreeId: undefined,
    state: 'working',
    prompt: 'Fix the auth bug',
    assistantMessage: undefined,
    isReplay: false,
    ...overrides
  }
}

describe('maybeAutoRenameBranchOnFirstWork', () => {
  beforeEach(() => {
    resetFirstWorkBranchRenameState()
    vi.clearAllMocks()
    getGitUsernameMock.mockReturnValue('you')
    getSshGitUsernameMock.mockResolvedValue('you')
    getSshGitProviderMock.mockReturnValue(undefined)
    computeBranchNameMock.mockImplementation((leaf: string) => `you/${leaf}`)
    prepareLocalEnvMock.mockResolvedValue({ ok: true })
    resolveTextGenerationParamsMock.mockReturnValue({
      ok: true,
      params: { agentId: 'claude', model: 'm' }
    })
    generateBranchNameMock.mockResolvedValue({ success: true, slug: 'fix-auth' })
    gitExecFileAsyncMock.mockImplementation(
      gitResponder({ currentBranch: 'you/Nautilus', hasUpstream: false })
    )
  })

  it('renames a fresh creature branch and its display name from the generated slug', async () => {
    const { deps, onRenamed, setDisplayName } = makeDeps()
    await maybeAutoRenameBranchOnFirstWork(workingEvent(), deps)
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      ['branch', '-m', 'you/fix-auth'],
      expect.objectContaining({ cwd: '/repo/wt' })
    )
    expect(resolveTextGenerationParamsMock).toHaveBeenCalledWith(
      expect.anything(),
      'local',
      'branchName',
      expect.objectContaining({ id: REPO_ID })
    )
    expect(setDisplayName).toHaveBeenCalledWith(WORKTREE_ID, 'Fix auth')
    expect(onRenamed).toHaveBeenCalledWith(REPO_ID)
  })

  it('leaves a user-customized display name untouched while still renaming the branch', async () => {
    const { deps, setDisplayName } = makeDeps({ getCurrentDisplayName: () => 'My cool feature' })
    await maybeAutoRenameBranchOnFirstWork(workingEvent(), deps)
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      ['branch', '-m', 'you/fix-auth'],
      expect.objectContaining({ cwd: '/repo/wt' })
    )
    expect(setDisplayName).not.toHaveBeenCalled()
  })

  it('resolves the worktree from the tab when the hook payload omits worktreeId', async () => {
    // workingEvent() carries worktreeId: undefined; resolveWorktreeIdForTab supplies it.
    const { deps, onRenamed } = makeDeps()
    await maybeAutoRenameBranchOnFirstWork(workingEvent(), deps)
    expect(onRenamed).toHaveBeenCalledWith(REPO_ID)
  })

  it('skips when no worktree can be resolved for the tab', async () => {
    const { deps } = makeDeps({ resolveWorktreeIdForTab: () => undefined })
    await maybeAutoRenameBranchOnFirstWork(workingEvent({ worktreeId: undefined }), deps)
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('does nothing when the setting is off', async () => {
    const settings = { autoRenameBranchFromWork: false } as unknown as GlobalSettings
    const { deps } = makeDeps({ getSettings: () => settings })
    await maybeAutoRenameBranchOnFirstWork(workingEvent(), deps)
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('ignores replayed events and non-working states', async () => {
    const { deps } = makeDeps()
    await maybeAutoRenameBranchOnFirstWork(workingEvent({ isReplay: true }), deps)
    await maybeAutoRenameBranchOnFirstWork(workingEvent({ state: 'done' }), deps)
    await maybeAutoRenameBranchOnFirstWork(workingEvent({ prompt: '   ' }), deps)
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('does not re-attempt after a successful rename', async () => {
    const { deps } = makeDeps()
    await maybeAutoRenameBranchOnFirstWork(workingEvent(), deps)
    generateBranchNameMock.mockClear()
    await maybeAutoRenameBranchOnFirstWork(workingEvent(), deps)
    expect(generateBranchNameMock).not.toHaveBeenCalled()
  })

  it('retries on a later event after a transient failure (does not poison the worktree)', async () => {
    generateBranchNameMock.mockResolvedValueOnce({ success: false, error: 'agent not ready' })
    const { deps, onRenamed } = makeDeps()
    await maybeAutoRenameBranchOnFirstWork(workingEvent(), deps)
    expect(onRenamed).not.toHaveBeenCalled()

    await maybeAutoRenameBranchOnFirstWork(workingEvent(), deps)
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      ['branch', '-m', 'you/fix-auth'],
      expect.objectContaining({ cwd: '/repo/wt' })
    )
    expect(onRenamed).toHaveBeenCalledWith(REPO_ID)
  })

  it('leaves a user-named branch untouched', async () => {
    gitExecFileAsyncMock.mockImplementation(
      gitResponder({ currentBranch: 'you/my-feature', hasUpstream: false })
    )
    const { deps, onRenamed } = makeDeps()
    await maybeAutoRenameBranchOnFirstWork(workingEvent(), deps)
    expect(generateBranchNameMock).not.toHaveBeenCalled()
    expect(onRenamed).not.toHaveBeenCalled()
  })

  it('refuses to rename a branch that already has an upstream', async () => {
    gitExecFileAsyncMock.mockImplementation(
      gitResponder({ currentBranch: 'you/Nautilus', hasUpstream: true })
    )
    const { deps, onRenamed } = makeDeps()
    await maybeAutoRenameBranchOnFirstWork(workingEvent(), deps)
    expect(generateBranchNameMock).not.toHaveBeenCalled()
    expect(onRenamed).not.toHaveBeenCalled()
  })

  it('leaves ineligible branches untouched even when their leaf is a creature name', async () => {
    const { deps, onRenamed } = makeDeps({ canRenameOrcaCreatedBranch: () => false })
    await maybeAutoRenameBranchOnFirstWork(workingEvent(), deps)
    expect(generateBranchNameMock).not.toHaveBeenCalled()
    expect(onRenamed).not.toHaveBeenCalled()
  })

  it('suffixes when the generated branch name already exists', async () => {
    gitExecFileAsyncMock.mockImplementation(
      gitResponder({
        currentBranch: 'you/Nautilus',
        hasUpstream: false,
        existingRefs: ['refs/heads/you/fix-auth']
      })
    )
    const { deps } = makeDeps()
    await maybeAutoRenameBranchOnFirstWork(workingEvent(), deps)
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      ['branch', '-m', 'you/fix-auth-2'],
      expect.objectContaining({ cwd: '/repo/wt' })
    )
  })

  it('does not rename when the branch changes while generation is running', async () => {
    let branchReadCount = 0
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref' && args[2] === 'HEAD') {
        branchReadCount += 1
        return { stdout: `${branchReadCount === 1 ? 'you/Nautilus' : 'you/manual'}\n`, stderr: '' }
      }
      if (args[0] === 'rev-parse' && args.some((arg) => arg.includes('@{u}'))) {
        throw noUpstreamError
      }
      if (args[0] === 'symbolic-ref') {
        return { stdout: 'you/Nautilus\n', stderr: '' }
      }
      if (args[0] === 'rev-parse' && args.includes('refs/remotes/origin/you/Nautilus')) {
        throw new Error('not found')
      }
      throw new Error(`unexpected git args: ${args.join(' ')}`)
    })
    const { deps, onRenamed } = makeDeps()
    await maybeAutoRenameBranchOnFirstWork(workingEvent(), deps)
    expect(gitExecFileAsyncMock).not.toHaveBeenCalledWith(
      ['branch', '-m', 'you/fix-auth'],
      expect.anything()
    )
    expect(onRenamed).not.toHaveBeenCalled()
  })

  it('does not rename when the branch gains an upstream while generation is running', async () => {
    let upstreamReadCount = 0
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref' && args[2] === 'HEAD') {
        return { stdout: 'you/Nautilus\n', stderr: '' }
      }
      if (args[0] === 'symbolic-ref') {
        return { stdout: 'you/Nautilus\n', stderr: '' }
      }
      if (args[0] === 'rev-parse' && args.some((arg) => arg.includes('@{u}'))) {
        upstreamReadCount += 1
        if (upstreamReadCount === 1) {
          throw noUpstreamError
        }
        return { stdout: 'origin/you/Nautilus\n', stderr: '' }
      }
      if (args[0] === 'rev-parse' && args.includes('refs/remotes/origin/you/Nautilus')) {
        throw new Error('not found')
      }
      throw new Error(`unexpected git args: ${args.join(' ')}`)
    })
    const { deps, onRenamed } = makeDeps()
    await maybeAutoRenameBranchOnFirstWork(workingEvent(), deps)
    expect(gitExecFileAsyncMock).not.toHaveBeenCalledWith(
      ['branch', '-m', 'you/fix-auth'],
      expect.anything()
    )
    expect(onRenamed).not.toHaveBeenCalled()
  })

  it('uses the SSH git provider and remote generation target for remote worktrees', async () => {
    getSshGitUsernameMock.mockResolvedValue('remote-user')
    const provider = {
      exec: vi.fn(gitResponder({ currentBranch: 'remote-user/Nautilus', hasUpstream: false })),
      renameCurrentBranch: vi.fn(async () => undefined),
      executeCommitMessagePlan: vi.fn()
    }
    getSshGitProviderMock.mockReturnValue(provider as never)
    const repo = { id: REPO_ID, path: '/repo', connectionId: 'ssh-1' } as unknown as Repo
    const { deps } = makeDeps({ getRepo: () => repo })

    await maybeAutoRenameBranchOnFirstWork(workingEvent(), deps)

    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
    expect(prepareLocalEnvMock).not.toHaveBeenCalled()
    expect(generateBranchNameMock).toHaveBeenCalledWith(
      { firstPrompt: 'Fix the auth bug', assistantMessage: undefined },
      { agentId: 'claude', model: 'm' },
      expect.objectContaining({
        kind: 'remote',
        cwd: '/repo/wt',
        missingBinaryLocation: 'remote PATH'
      })
    )
    expect(computeBranchNameMock).toHaveBeenCalledWith('fix-auth', expect.anything(), 'remote-user')
    expect(provider.exec).not.toHaveBeenCalledWith(['branch', '-m', 'you/fix-auth'], '/repo/wt')
    expect(provider.renameCurrentBranch).toHaveBeenCalledWith('/repo/wt', 'you/fix-auth')
  })

  it('retries when the SSH provider is unavailable on the first working event', async () => {
    const provider = {
      exec: vi.fn(gitResponder({ currentBranch: 'you/Nautilus', hasUpstream: false })),
      renameCurrentBranch: vi.fn(async () => undefined),
      executeCommitMessagePlan: vi.fn()
    }
    getSshGitProviderMock.mockReturnValueOnce(undefined).mockReturnValue(provider as never)
    const repo = { id: REPO_ID, path: '/repo', connectionId: 'ssh-1' } as unknown as Repo
    const { deps, onRenamed } = makeDeps({ getRepo: () => repo })

    await maybeAutoRenameBranchOnFirstWork(workingEvent(), deps)
    expect(onRenamed).not.toHaveBeenCalled()

    await maybeAutoRenameBranchOnFirstWork(workingEvent(), deps)
    expect(provider.renameCurrentBranch).toHaveBeenCalledWith('/repo/wt', 'you/fix-auth')
    expect(onRenamed).toHaveBeenCalledWith(REPO_ID)
  })
})

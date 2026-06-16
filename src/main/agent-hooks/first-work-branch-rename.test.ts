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
  computeBranchNameMock,
  getConfiguredBranchPrefixMock
} = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn(),
  getGitUsernameMock: vi.fn(() => 'you'),
  getSshGitUsernameMock: vi.fn(async () => 'you'),
  getSshGitProviderMock: vi.fn(() => undefined),
  generateBranchNameMock: vi.fn(),
  resolveTextGenerationParamsMock: vi.fn(),
  prepareLocalEnvMock: vi.fn(async () => ({ ok: true as const })),
  computeBranchNameMock: vi.fn((leaf: string) => `you/${leaf}`),
  // Mirror computeBranchNameMock's `you/` strategy so prefix stripping is realistic.
  getConfiguredBranchPrefixMock: vi.fn((_settings: unknown, username: string | null) => username)
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
vi.mock('../ipc/worktree-logic', () => ({
  computeBranchName: computeBranchNameMock,
  getConfiguredBranchPrefix: getConfiguredBranchPrefixMock
}))

import {
  FIRST_WORK_BRANCH_RENAME_SETTLED_CACHE_LIMIT,
  maybeAutoRenameBranchOnFirstWork,
  resetFirstWorkBranchRenameState,
  type FirstWorkBranchRenameDeps
} from './first-work-branch-rename'
import {
  FOLDER_WORKTREE_ID,
  REPO_ID,
  WORKTREE_ID,
  gitResponder,
  makeBranchRenameDeps,
  noUpstreamError,
  workingEvent
} from './first-work-branch-rename-test-harness'

function makeDeps(overrides: Partial<FirstWorkBranchRenameDeps> = {}) {
  return makeBranchRenameDeps(vi.fn, overrides)
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

  it('asks to align the on-disk folder with the generated slug after renaming', async () => {
    const { deps, renameWorktreeFolder } = makeDeps()
    await maybeAutoRenameBranchOnFirstWork(workingEvent(), deps)
    expect(renameWorktreeFolder).toHaveBeenCalledWith(WORKTREE_ID, 'fix-auth')
  })

  it('skips the redundant branch-rename notify when the folder rename succeeded', async () => {
    // The folder rename already pushed a worktrees:changed carrying the id mapping,
    // so onRenamed would only trigger a second, redundant renderer re-list.
    const { deps, onRenamed } = makeDeps({ renameWorktreeFolder: vi.fn(async () => true) })
    await maybeAutoRenameBranchOnFirstWork(workingEvent(), deps)
    expect(onRenamed).not.toHaveBeenCalled()
  })

  it('survives a folder-rename failure without undoing the branch/display rename', async () => {
    const { deps, onRenamed, setDisplayName } = makeDeps({
      renameWorktreeFolder: vi.fn(async () => {
        throw new Error('git worktree move failed')
      })
    })
    await maybeAutoRenameBranchOnFirstWork(workingEvent(), deps)
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      ['branch', '-m', 'you/fix-auth'],
      expect.objectContaining({ cwd: '/repo/wt' })
    )
    expect(setDisplayName).toHaveBeenCalledWith(WORKTREE_ID, 'Fix auth')
    expect(onRenamed).toHaveBeenCalledWith(REPO_ID)
  })

  it('strips a prefix the model leaked into the slug from both branch and display name', async () => {
    // Model ignored "no prefixes" and echoed `you/worktree-spinner`, which the
    // sanitizer folds to `you-worktree-spinner`; without stripping it would
    // double-prefix the branch (`you/you-...`) and show "You worktree spinner".
    generateBranchNameMock.mockResolvedValue({ success: true, slug: 'you-worktree-spinner' })
    const { deps, setDisplayName } = makeDeps()
    await maybeAutoRenameBranchOnFirstWork(workingEvent(), deps)
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      ['branch', '-m', 'you/worktree-spinner'],
      expect.objectContaining({ cwd: '/repo/wt' })
    )
    expect(setDisplayName).toHaveBeenCalledWith(WORKTREE_ID, 'Worktree spinner')
  })

  it('skips the rename when the model echoes only the configured prefix', async () => {
    // The model emitted just `you` (the prefix); stripping leaves an empty slug,
    // so renaming would re-add the prefix and double it to `you/you`.
    generateBranchNameMock.mockResolvedValue({ success: true, slug: 'you' })
    const { deps, onRenamed, setRenameError } = makeDeps()
    await maybeAutoRenameBranchOnFirstWork(workingEvent(), deps)
    expect(gitExecFileAsyncMock).not.toHaveBeenCalledWith(
      ['branch', '-m', expect.anything()],
      expect.anything()
    )
    expect(onRenamed).not.toHaveBeenCalled()
    // Benign terminal state: clear any stale badge, never raise a new one.
    expect(setRenameError).not.toHaveBeenCalledWith(WORKTREE_ID, expect.any(String))
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

  it('renames a pending folder workspace title without touching git', async () => {
    const { deps, onRenamed, setDisplayName } = makeDeps({
      resolveWorktreeIdForTab: () => FOLDER_WORKTREE_ID,
      getFolderWorkspacePath: () => '/workspace/platform',
      isPendingFirstAgentMessageRename: () => true,
      getCurrentDisplayName: () => 'Platform workspace'
    })

    await maybeAutoRenameBranchOnFirstWork(workingEvent(), deps)

    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
    expect(resolveTextGenerationParamsMock).toHaveBeenCalledWith(
      expect.anything(),
      'local',
      'branchName',
      null
    )
    expect(setDisplayName).toHaveBeenCalledWith(FOLDER_WORKTREE_ID, 'Fix auth')
    expect(onRenamed).toHaveBeenCalledWith(FOLDER_WORKTREE_ID)
  })

  it('does not rename folder workspace titles without the pending marker', async () => {
    const { deps, setDisplayName } = makeDeps({
      resolveWorktreeIdForTab: () => FOLDER_WORKTREE_ID,
      getFolderWorkspacePath: () => '/workspace/platform',
      isPendingFirstAgentMessageRename: () => false
    })

    await maybeAutoRenameBranchOnFirstWork(workingEvent(), deps)

    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
    expect(generateBranchNameMock).not.toHaveBeenCalled()
    expect(setDisplayName).not.toHaveBeenCalled()
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

  it('bounds settled worktree dedupe while keeping recent entries', async () => {
    gitExecFileAsyncMock.mockImplementation(
      gitResponder({ currentBranch: 'you/my-feature', hasUpstream: false })
    )
    const { deps } = makeDeps()
    const firstWorktreeId = `${REPO_ID}${WORKTREE_ID_SEPARATOR}/repo/wt-0`
    const lastWorktreeId = `${REPO_ID}${WORKTREE_ID_SEPARATOR}/repo/wt-${FIRST_WORK_BRANCH_RENAME_SETTLED_CACHE_LIMIT}`

    for (let index = 0; index <= FIRST_WORK_BRANCH_RENAME_SETTLED_CACHE_LIMIT; index += 1) {
      await maybeAutoRenameBranchOnFirstWork(
        workingEvent({
          tabId: undefined,
          paneKey: '',
          worktreeId: `${REPO_ID}${WORKTREE_ID_SEPARATOR}/repo/wt-${index}`
        }),
        deps
      )
    }
    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(
      FIRST_WORK_BRANCH_RENAME_SETTLED_CACHE_LIMIT + 1
    )

    gitExecFileAsyncMock.mockClear()
    await maybeAutoRenameBranchOnFirstWork(
      workingEvent({ tabId: undefined, paneKey: '', worktreeId: firstWorktreeId }),
      deps
    )
    await maybeAutoRenameBranchOnFirstWork(
      workingEvent({ tabId: undefined, paneKey: '', worktreeId: lastWorktreeId }),
      deps
    )

    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(1)
  })

  it('retries on a later event after a transient failure (does not poison the worktree)', async () => {
    generateBranchNameMock.mockResolvedValueOnce({ success: false, error: 'agent not ready' })
    const { deps, onRenamed, setRenameError } = makeDeps()
    await maybeAutoRenameBranchOnFirstWork(workingEvent(), deps)
    expect(onRenamed).not.toHaveBeenCalled()

    await maybeAutoRenameBranchOnFirstWork(workingEvent(), deps)
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      ['branch', '-m', 'you/fix-auth'],
      expect.objectContaining({ cwd: '/repo/wt' })
    )
    expect(onRenamed).toHaveBeenCalledWith(REPO_ID)
    // The eventual success must clear the error raised on the first attempt.
    expect(setRenameError).toHaveBeenLastCalledWith(WORKTREE_ID, null)
  })

  it('records a user-facing error when branch-name generation fails', async () => {
    generateBranchNameMock.mockResolvedValueOnce({ success: false, error: 'agent not ready' })
    const { deps, setRenameError } = makeDeps()
    await maybeAutoRenameBranchOnFirstWork(workingEvent(), deps)
    expect(setRenameError).toHaveBeenCalledWith(WORKTREE_ID, 'agent not ready')
  })

  it('records a user-facing error when no generation agent is configured', async () => {
    resolveTextGenerationParamsMock.mockReturnValueOnce({
      ok: false,
      error: 'No agent configured.'
    })
    const { deps, setRenameError } = makeDeps()
    await maybeAutoRenameBranchOnFirstWork(workingEvent(), deps)
    expect(setRenameError).toHaveBeenCalledWith(WORKTREE_ID, 'No agent configured.')
  })

  it('clears any stale error after a successful rename', async () => {
    const { deps, setRenameError } = makeDeps()
    await maybeAutoRenameBranchOnFirstWork(workingEvent(), deps)
    expect(setRenameError).toHaveBeenCalledWith(WORKTREE_ID, null)
  })

  it('leaves a user-named branch untouched', async () => {
    gitExecFileAsyncMock.mockImplementation(
      gitResponder({ currentBranch: 'you/my-feature', hasUpstream: false })
    )
    const { deps, onRenamed, setRenameError } = makeDeps()
    await maybeAutoRenameBranchOnFirstWork(workingEvent(), deps)
    expect(generateBranchNameMock).not.toHaveBeenCalled()
    expect(onRenamed).not.toHaveBeenCalled()
    // Benign skip (user-named branch) must never raise the failure badge; it may
    // only clear a stale one (null), never set a non-null error message.
    expect(setRenameError).not.toHaveBeenCalledWith(WORKTREE_ID, expect.any(String))
  })

  it('clears a stale error when a retryable worktree later reaches a benign stop', async () => {
    // First event: transient generation failure raises the badge.
    generateBranchNameMock.mockResolvedValueOnce({ success: false, error: 'agent not ready' })
    const { deps, setRenameError } = makeDeps()
    await maybeAutoRenameBranchOnFirstWork(workingEvent(), deps)
    expect(setRenameError).toHaveBeenCalledWith(WORKTREE_ID, 'agent not ready')

    // Second event: the user has since pushed the branch, so it settles benignly.
    // The stale "rename failed" badge must be cleared rather than stick forever.
    gitExecFileAsyncMock.mockImplementation(
      gitResponder({ currentBranch: 'you/Nautilus', hasUpstream: true })
    )
    await maybeAutoRenameBranchOnFirstWork(workingEvent(), deps)
    expect(setRenameError).toHaveBeenLastCalledWith(WORKTREE_ID, null)
  })

  it('does not raise the failure badge when generation is canceled by the user', async () => {
    generateBranchNameMock.mockResolvedValueOnce({
      success: false,
      error: 'Generation canceled.',
      canceled: true
    })
    const { deps, setRenameError } = makeDeps()
    await maybeAutoRenameBranchOnFirstWork(workingEvent(), deps)
    expect(setRenameError).not.toHaveBeenCalledWith(WORKTREE_ID, 'Generation canceled.')
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

  it('suffixes the branch, display name, and folder together on collision', async () => {
    gitExecFileAsyncMock.mockImplementation(
      gitResponder({
        currentBranch: 'you/Nautilus',
        hasUpstream: false,
        existingRefs: ['refs/heads/you/fix-auth']
      })
    )
    const { deps, setDisplayName, renameWorktreeFolder } = makeDeps()
    await maybeAutoRenameBranchOnFirstWork(workingEvent(), deps)
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      ['branch', '-m', 'you/fix-auth-2'],
      expect.objectContaining({ cwd: '/repo/wt' })
    )
    // Display name and folder must follow the resolved (suffixed) leaf, not the
    // pre-suffix slug — otherwise they diverge from the branch.
    expect(setDisplayName).toHaveBeenCalledWith(WORKTREE_ID, 'Fix auth 2')
    expect(renameWorktreeFolder).toHaveBeenCalledWith(WORKTREE_ID, 'fix-auth-2')
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

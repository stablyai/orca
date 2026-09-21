import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  handlers,
  store,
  REPO_PATH,
  WORKTREE_FEATURE_PATH,
  realpathMock,
  getStatusMock,
  abortMergeMock,
  abortRebaseMock,
  stageFileMock,
  bulkStageFilesMock,
  bulkUnstageFilesMock,
  bulkDiscardChangesMock,
  discardChangesMock,
  checkIgnoredPathsMock,
  listWorktreesMock,
  getSshGitProviderMock,
  resetFilesystemIpcMocks
} from './filesystem-test-harness'

vi.mock('electron', async () => (await import('./filesystem-test-harness')).electronMock)
vi.mock('fs/promises', async () => (await import('./filesystem-test-harness')).fsPromisesMock)
vi.mock(
  '../wsl-unc-delete',
  async () => (await import('./filesystem-test-harness')).wslUncDeleteMock
)
vi.mock(
  '../crash-reporting/crash-breadcrumb-store',
  async () => (await import('./filesystem-test-harness')).crashBreadcrumbMock
)
vi.mock(
  '../local-downloaded-folder-promotion',
  async () => (await import('./filesystem-test-harness')).folderPromotionMock
)
vi.mock(
  '../git/status',
  async () => (await import('./filesystem-test-harness')).gitStatusModuleMock
)
vi.mock(
  '../git/check-ignored-paths',
  async () => (await import('./filesystem-test-harness')).gitIgnoredPathsMock
)
vi.mock('../git/worktree', async () => (await import('./filesystem-test-harness')).gitWorktreeMock)
vi.mock(
  '../providers/ssh-filesystem-dispatch',
  async () => (await import('./filesystem-test-harness')).sshFilesystemDispatchMock
)
vi.mock(
  '../providers/ssh-git-dispatch',
  async () => (await import('./filesystem-test-harness')).sshGitDispatchMock
)
vi.mock(
  '../text-generation/commit-message-text-generation',
  async () => (await import('./filesystem-test-harness')).textGenerationModuleMock
)
vi.mock(
  '../text-generation/pull-request-context',
  async () => (await import('./filesystem-test-harness')).pullRequestContextMock
)
vi.mock(
  '../source-control/pull-request-template',
  async () => (await import('./filesystem-test-harness')).pullRequestTemplateMock
)
vi.mock(
  '../source-control/pull-request-linked-issue',
  async () => (await import('./filesystem-test-harness')).pullRequestLinkedIssueMock
)

import { registerFilesystemHandlers } from './filesystem'
import {
  registerWorktreeRootsForRepo,
  invalidateAuthorizedRootsCache
} from './registered-worktree-roots-cache'

describe('registerFilesystemHandlers', () => {
  beforeEach(() => {
    resetFilesystemIpcMocks()
    // Reset module-level auth cache so each test starts with a fresh dirty
    // flag — prevents stale worktree data from a prior test's cache rebuild.
    invalidateAuthorizedRootsCache()
  })

  it('normalizes repo worktree paths and keeps git file paths relative', async () => {
    stageFileMock.mockResolvedValue(undefined)

    registerFilesystemHandlers(store as never)

    await handlers.get('git:stage')!(null, {
      worktreePath: WORKTREE_FEATURE_PATH,
      filePath: './src/../src/file.ts'
    })

    // Why: validateGitRelativeFilePath uses path.relative() which produces
    // platform-specific separators (backslashes on Windows).
    expect(stageFileMock).toHaveBeenCalledWith(WORKTREE_FEATURE_PATH, path.join('src', 'file.ts'), {
      admissionTier: 'interactive'
    })
  })

  it('uses worktree roots seeded by worktrees:list without rebuilding the cache', async () => {
    registerWorktreeRootsForRepo(store as never, 'repo-1', [REPO_PATH, WORKTREE_FEATURE_PATH])
    getStatusMock.mockResolvedValue({ entries: [] })

    registerFilesystemHandlers(store as never)

    await handlers.get('git:status')!(null, { worktreePath: WORKTREE_FEATURE_PATH })

    expect(listWorktreesMock).not.toHaveBeenCalled()
    expect(realpathMock).not.toHaveBeenCalledWith(WORKTREE_FEATURE_PATH)
    expect(getStatusMock).toHaveBeenCalledWith(WORKTREE_FEATURE_PATH, {
      admissionTier: 'status',
      includeIgnored: false
    })
  })

  it('passes configured shared links through the local status path', async () => {
    const sharedStore = {
      ...store,
      getRepos: () => [
        {
          ...store.getRepos()[0],
          symlinkPaths: ['node_modules']
        }
      ],
      getAllWorktreeMeta: () => ({
        [`repo-1::${WORKTREE_FEATURE_PATH}`]: {}
      })
    }
    registerWorktreeRootsForRepo(sharedStore as never, 'repo-1', [REPO_PATH, WORKTREE_FEATURE_PATH])
    getStatusMock.mockResolvedValue({ entries: [] })

    registerFilesystemHandlers(sharedStore as never)

    await handlers.get('git:status')!(null, { worktreePath: WORKTREE_FEATURE_PATH })

    expect(getStatusMock).toHaveBeenCalledWith(WORKTREE_FEATURE_PATH, {
      admissionTier: 'status',
      includeIgnored: false,
      sharedLinkPaths: ['node_modules']
    })
  })

  it('allows git operations on the known repo root without rebuilding the worktree cache', async () => {
    getStatusMock.mockResolvedValue({ entries: [] })

    registerFilesystemHandlers(store as never)

    await handlers.get('git:status')!(null, { worktreePath: REPO_PATH })

    expect(listWorktreesMock).not.toHaveBeenCalled()
    expect(realpathMock).not.toHaveBeenCalledWith(REPO_PATH)
    expect(getStatusMock).toHaveBeenCalledWith(REPO_PATH, {
      admissionTier: 'status',
      includeIgnored: false
    })
  })

  it('forwards includeIgnored through local and SSH git status IPC', async () => {
    registerWorktreeRootsForRepo(store as never, 'repo-1', [REPO_PATH, WORKTREE_FEATURE_PATH])
    getStatusMock.mockResolvedValue({ entries: [], conflictOperation: 'unknown' })
    const sshProvider = {
      getStatus: vi.fn().mockResolvedValue({ entries: [], conflictOperation: 'unknown' })
    }
    getSshGitProviderMock.mockReturnValue(sshProvider)

    registerFilesystemHandlers(store as never)

    await handlers.get('git:status')!(null, {
      worktreePath: WORKTREE_FEATURE_PATH,
      includeIgnored: true
    })
    await handlers.get('git:status')!(null, {
      worktreePath: '/remote/repo',
      connectionId: 'ssh-1',
      includeIgnored: true
    })

    expect(getStatusMock).toHaveBeenCalledWith(WORKTREE_FEATURE_PATH, {
      admissionTier: 'status',
      includeIgnored: true
    })
    expect(sshProvider.getStatus).toHaveBeenCalledWith('/remote/repo', {
      admissionTier: 'status',
      includeIgnored: true
    })
  })

  it('returns capped-state metadata unchanged across local and SSH status IPC', async () => {
    const cappedStatus = {
      entries: [{ path: 'generated/a.ts', status: 'untracked', area: 'untracked' }],
      conflictOperation: 'unknown',
      didHitLimit: true,
      statusLength: 1_001
    }
    registerWorktreeRootsForRepo(store as never, 'repo-1', [REPO_PATH, WORKTREE_FEATURE_PATH])
    getStatusMock.mockResolvedValue(cappedStatus)
    const sshProvider = { getStatus: vi.fn().mockResolvedValue(cappedStatus) }
    getSshGitProviderMock.mockReturnValue(sshProvider)
    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('git:status')!(null, { worktreePath: WORKTREE_FEATURE_PATH })
    ).resolves.toEqual(cappedStatus)
    await expect(
      handlers.get('git:status')!(null, {
        worktreePath: '/remote/repo',
        connectionId: 'ssh-1'
      })
    ).resolves.toEqual(cappedStatus)
  })

  it('forwards upstream-negative-cache bypass through local and SSH git status IPC', async () => {
    registerWorktreeRootsForRepo(store as never, 'repo-1', [REPO_PATH, WORKTREE_FEATURE_PATH])
    getStatusMock.mockResolvedValue({ entries: [], conflictOperation: 'unknown' })
    const sshProvider = {
      getStatus: vi.fn().mockResolvedValue({ entries: [], conflictOperation: 'unknown' })
    }
    getSshGitProviderMock.mockReturnValue(sshProvider)

    registerFilesystemHandlers(store as never)

    await handlers.get('git:status')!(null, {
      worktreePath: WORKTREE_FEATURE_PATH,
      bypassEffectiveUpstreamNegativeCache: true
    })
    await handlers.get('git:status')!(null, {
      worktreePath: '/remote/repo',
      connectionId: 'ssh-1',
      bypassEffectiveUpstreamNegativeCache: true
    })

    expect(getStatusMock).toHaveBeenCalledWith(WORKTREE_FEATURE_PATH, {
      admissionTier: 'status',
      includeIgnored: false,
      bypassEffectiveUpstreamNegativeCache: true
    })
    expect(sshProvider.getStatus).toHaveBeenCalledWith('/remote/repo', {
      admissionTier: 'status',
      includeIgnored: false,
      bypassEffectiveUpstreamNegativeCache: true
    })
  })

  it('forwards line-stat reuse through local and SSH git status IPC', async () => {
    registerWorktreeRootsForRepo(store as never, 'repo-1', [REPO_PATH, WORKTREE_FEATURE_PATH])
    getStatusMock.mockResolvedValue({ entries: [], conflictOperation: 'unknown' })
    const sshProvider = {
      getStatus: vi.fn().mockResolvedValue({ entries: [], conflictOperation: 'unknown' })
    }
    getSshGitProviderMock.mockReturnValue(sshProvider)
    registerFilesystemHandlers(store as never)

    await handlers.get('git:status')!(null, {
      worktreePath: WORKTREE_FEATURE_PATH,
      reuseLineStats: true
    })
    await handlers.get('git:status')!(null, {
      worktreePath: '/remote/repo',
      connectionId: 'ssh-1',
      reuseLineStats: true
    })

    expect(getStatusMock).toHaveBeenCalledWith(WORKTREE_FEATURE_PATH, {
      admissionTier: 'status',
      includeIgnored: false,
      reuseLineStats: true
    })
    expect(sshProvider.getStatus).toHaveBeenCalledWith('/remote/repo', {
      admissionTier: 'status',
      includeIgnored: false,
      reuseLineStats: true
    })
  })

  it('forwards a false line-stats request through local and SSH git status IPC', async () => {
    registerWorktreeRootsForRepo(store as never, 'repo-1', [REPO_PATH, WORKTREE_FEATURE_PATH])
    getStatusMock.mockResolvedValue({ entries: [], conflictOperation: 'unknown' })
    const sshProvider = {
      getStatus: vi.fn().mockResolvedValue({ entries: [], conflictOperation: 'unknown' })
    }
    getSshGitProviderMock.mockReturnValue(sshProvider)
    registerFilesystemHandlers(store as never)

    await handlers.get('git:status')!(null, {
      worktreePath: WORKTREE_FEATURE_PATH,
      includeLineStats: false
    })
    await handlers.get('git:status')!(null, {
      worktreePath: '/remote/repo',
      connectionId: 'ssh-1',
      includeLineStats: false
    })

    expect(getStatusMock).toHaveBeenCalledWith(WORKTREE_FEATURE_PATH, {
      admissionTier: 'status',
      includeIgnored: false,
      includeLineStats: false
    })
    expect(sshProvider.getStatus).toHaveBeenCalledWith('/remote/repo', {
      admissionTier: 'status',
      includeIgnored: false,
      includeLineStats: false
    })
  })

  it('aborts tokenized local status without crossing renderer boundaries', async () => {
    registerWorktreeRootsForRepo(store as never, 'repo-1', [REPO_PATH, WORKTREE_FEATURE_PATH])
    const statusSignals: AbortSignal[] = []
    getStatusMock.mockImplementation(
      (_worktreePath: string, options: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          if (options.signal) {
            statusSignals.push(options.signal)
            options.signal.addEventListener('abort', () => reject(new Error('aborted')), {
              once: true
            })
          }
        })
    )
    registerFilesystemHandlers(store as never)

    const firstEvent = { sender: { id: 7 } }
    const secondEvent = { sender: { id: 8 } }
    const firstRequest = handlers.get('git:status')!(firstEvent, {
      worktreePath: WORKTREE_FEATURE_PATH,
      requestToken: 'status-1'
    }) as Promise<unknown>
    const secondRequest = handlers.get('git:status')!(secondEvent, {
      worktreePath: WORKTREE_FEATURE_PATH,
      requestToken: 'status-1'
    }) as Promise<unknown>
    await vi.waitFor(() => expect(statusSignals).toHaveLength(2))
    await handlers.get('git:cancelStatus')!(firstEvent, { requestToken: 'status-1' })

    expect(statusSignals[0]?.aborted).toBe(true)
    expect(statusSignals[1]?.aborted).toBe(false)
    await expect(firstRequest).rejects.toThrow('aborted')

    await handlers.get('git:cancelStatus')!(secondEvent, { requestToken: 'status-1' })
    await expect(secondRequest).rejects.toThrow('aborted')
  })

  it('checks ignored paths through local and SSH git providers', async () => {
    registerWorktreeRootsForRepo(store as never, 'repo-1', [REPO_PATH, WORKTREE_FEATURE_PATH])
    checkIgnoredPathsMock.mockResolvedValue(['dist/bundle.js'])
    const sshProvider = {
      checkIgnoredPaths: vi.fn().mockResolvedValue(['build/output.js'])
    }
    getSshGitProviderMock.mockReturnValue(sshProvider)

    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('git:checkIgnored')!(null, {
        worktreePath: WORKTREE_FEATURE_PATH,
        paths: ['dist/bundle.js', 'src/index.ts']
      })
    ).resolves.toEqual(['dist/bundle.js'])
    await expect(
      handlers.get('git:checkIgnored')!(null, {
        worktreePath: '/remote/repo',
        connectionId: 'ssh-1',
        paths: ['build/output.js']
      })
    ).resolves.toEqual(['build/output.js'])

    expect(checkIgnoredPathsMock).toHaveBeenCalledWith(
      WORKTREE_FEATURE_PATH,
      [path.join('dist', 'bundle.js'), path.join('src', 'index.ts')],
      {}
    )
    expect(sshProvider.checkIgnoredPaths).toHaveBeenCalledWith('/remote/repo', [
      path.join('build', 'output.js')
    ])
  })

  it('routes abort merge through local and SSH git providers', async () => {
    registerWorktreeRootsForRepo(store as never, 'repo-1', [REPO_PATH, WORKTREE_FEATURE_PATH])
    abortMergeMock.mockResolvedValue(undefined)
    const sshProvider = {
      abortMerge: vi.fn().mockResolvedValue(undefined)
    }
    getSshGitProviderMock.mockReturnValue(sshProvider)

    registerFilesystemHandlers(store as never)

    await handlers.get('git:abortMerge')!(null, { worktreePath: WORKTREE_FEATURE_PATH })
    await handlers.get('git:abortMerge')!(null, {
      worktreePath: '/remote/repo',
      connectionId: 'ssh-1'
    })

    expect(abortMergeMock).toHaveBeenCalledWith(WORKTREE_FEATURE_PATH, {
      admissionTier: 'interactive'
    })
    expect(sshProvider.abortMerge).toHaveBeenCalledWith('/remote/repo')
  })

  it('routes abort rebase through local and SSH git providers', async () => {
    registerWorktreeRootsForRepo(store as never, 'repo-1', [REPO_PATH, WORKTREE_FEATURE_PATH])
    abortRebaseMock.mockResolvedValue(undefined)
    const sshProvider = {
      abortRebase: vi.fn().mockResolvedValue(undefined)
    }
    getSshGitProviderMock.mockReturnValue(sshProvider)

    registerFilesystemHandlers(store as never)

    await handlers.get('git:abortRebase')!(null, { worktreePath: WORKTREE_FEATURE_PATH })
    await handlers.get('git:abortRebase')!(null, {
      worktreePath: '/remote/repo',
      connectionId: 'ssh-1'
    })

    expect(abortRebaseMock).toHaveBeenCalledWith(WORKTREE_FEATURE_PATH, {
      admissionTier: 'interactive'
    })
    expect(sshProvider.abortRebase).toHaveBeenCalledWith('/remote/repo')
  })

  it('rejects git file paths that escape the selected worktree', async () => {
    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('git:discard')!(null, {
        worktreePath: WORKTREE_FEATURE_PATH,
        filePath: '../outside.txt'
      })
    ).rejects.toThrow('Access denied: git file path escapes the selected worktree')

    expect(discardChangesMock).not.toHaveBeenCalled()
  })

  it('rejects git operations for unknown worktrees', async () => {
    listWorktreesMock.mockResolvedValue([])

    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('git:status')!(null, {
        worktreePath: WORKTREE_FEATURE_PATH
      })
    ).rejects.toThrow('Access denied: unknown repository or worktree path')

    expect(getStatusMock).not.toHaveBeenCalled()
  })

  it('normalizes git file paths for bulk stage requests', async () => {
    bulkStageFilesMock.mockResolvedValue(undefined)

    registerFilesystemHandlers(store as never)

    await handlers.get('git:bulkStage')!(null, {
      worktreePath: WORKTREE_FEATURE_PATH,
      filePaths: ['./src/../src/file.ts', 'nested//child.ts']
    })

    expect(bulkStageFilesMock).toHaveBeenCalledWith(
      WORKTREE_FEATURE_PATH,
      [path.join('src', 'file.ts'), path.join('nested', 'child.ts')],
      { admissionTier: 'interactive' }
    )
  })

  it('normalizes git file paths for bulk discard requests', async () => {
    bulkDiscardChangesMock.mockResolvedValue(undefined)

    registerFilesystemHandlers(store as never)

    await handlers.get('git:bulkDiscard')!(null, {
      worktreePath: WORKTREE_FEATURE_PATH,
      filePaths: ['./src/../src/file.ts', 'nested//child.ts']
    })

    expect(bulkDiscardChangesMock).toHaveBeenCalledWith(
      WORKTREE_FEATURE_PATH,
      [path.join('src', 'file.ts'), path.join('nested', 'child.ts')],
      { admissionTier: 'interactive' }
    )
  })

  it('rejects bulk unstage requests that escape the selected worktree', async () => {
    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('git:bulkUnstage')!(null, {
        worktreePath: WORKTREE_FEATURE_PATH,
        filePaths: ['src/file.ts', '../outside.txt']
      })
    ).rejects.toThrow('Access denied: git file path escapes the selected worktree')

    expect(bulkUnstageFilesMock).not.toHaveBeenCalled()
  })

  it('rejects bulk discard requests that escape the selected worktree', async () => {
    registerFilesystemHandlers(store as never)

    await expect(
      handlers.get('git:bulkDiscard')!(null, {
        worktreePath: WORKTREE_FEATURE_PATH,
        filePaths: ['src/file.ts', '../outside.txt']
      })
    ).rejects.toThrow('Access denied: git file path escapes the selected worktree')

    expect(bulkDiscardChangesMock).not.toHaveBeenCalled()
  })
})

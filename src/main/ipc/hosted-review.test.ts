import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resolve } from 'path'

const ORIGINAL_PLATFORM = process.platform

// Why: WSL git-routing tests need deterministic Windows-only runtime branches.
function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value: platform
  })
}

const {
  handleMock,
  createHostedReviewMock,
  getHostedReviewCreationEligibilityMock,
  getHostedReviewForBranchMock,
  resolveRegisteredWorktreePathMock,
  listRepoWorktreesMock
} = vi.hoisted(() => ({
  handleMock: vi.fn(),
  createHostedReviewMock: vi.fn(),
  getHostedReviewCreationEligibilityMock: vi.fn(),
  getHostedReviewForBranchMock: vi.fn(),
  resolveRegisteredWorktreePathMock: vi.fn(),
  listRepoWorktreesMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: handleMock
  }
}))

vi.mock('../source-control/hosted-review-creation', () => ({
  createHostedReview: createHostedReviewMock,
  getHostedReviewCreationEligibility: getHostedReviewCreationEligibilityMock
}))

vi.mock('../source-control/hosted-review', () => ({
  getHostedReviewForBranch: getHostedReviewForBranchMock
}))

vi.mock('./filesystem-auth', () => ({
  resolveRegisteredWorktreePath: resolveRegisteredWorktreePathMock
}))

vi.mock('../repo-worktrees', () => ({
  listRepoWorktrees: listRepoWorktreesMock
}))

import { registerHostedReviewHandlers } from './hosted-review'

type HandlerMap = Record<string, (_event: unknown, args: unknown) => unknown>

describe('registerHostedReviewHandlers', () => {
  const handlers: HandlerMap = {}
  const repoPath = '/remote/workspace/repo'
  const worktreePath = '/remote/workspace/feature-worktree'
  const repo: {
    id: string
    path: string
    displayName: string
    badgeColor: string
    addedAt: number
    connectionId?: string
  } = {
    id: 'repo-1',
    path: repoPath,
    displayName: 'repo',
    badgeColor: '#000',
    addedAt: 0,
    connectionId: 'ssh-1'
  }
  const store = {
    getRepo: vi.fn((repoId: string) => (repoId === repo.id ? repo : null)),
    getRepos: vi.fn(() => [repo]),
    getProjects: vi.fn((): Record<string, unknown>[] => []),
    getSettings: vi.fn(() => ({ localWindowsRuntimeDefault: { kind: 'windows-host' } }))
  }
  const stats = {
    hasCountedPR: vi.fn(() => false),
    record: vi.fn()
  }

  beforeEach(() => {
    setPlatform(ORIGINAL_PLATFORM)
    handleMock.mockReset()
    createHostedReviewMock.mockReset()
    getHostedReviewCreationEligibilityMock.mockReset()
    getHostedReviewForBranchMock.mockReset()
    resolveRegisteredWorktreePathMock.mockReset()
    listRepoWorktreesMock.mockReset()
    store.getRepo.mockReset()
    store.getRepos.mockReset()
    store.getProjects.mockReset()
    store.getSettings.mockReset()
    stats.hasCountedPR.mockClear()
    stats.record.mockClear()
    for (const key of Object.keys(handlers)) {
      delete handlers[key]
    }
    handleMock.mockImplementation((channel, handler) => {
      handlers[channel] = handler
    })
    store.getRepo.mockImplementation((repoId: string) => (repoId === repo.id ? repo : null))
    store.getRepos.mockReturnValue([repo])
    store.getProjects.mockReturnValue([])
    store.getSettings.mockReturnValue({ localWindowsRuntimeDefault: { kind: 'windows-host' } })
    listRepoWorktreesMock.mockResolvedValue([{ path: worktreePath }])
  })

  it('routes local WSL project review creation through main-process runtime options', async () => {
    setPlatform('win32')
    const localRepo = {
      id: 'repo-local',
      path: '/workspace/repo',
      displayName: 'local',
      badgeColor: '#000',
      addedAt: 0
    }
    store.getRepo.mockImplementation((repoId: string) =>
      repoId === localRepo.id ? localRepo : null
    )
    store.getRepos.mockReturnValue([localRepo])
    store.getProjects.mockReturnValue([
      {
        id: 'project-1',
        displayName: 'local',
        badgeColor: '#000',
        sourceRepoIds: [localRepo.id],
        localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' },
        createdAt: 0,
        updatedAt: 0
      }
    ])
    const resolvedWorktreePath = resolve('/workspace/feature')
    resolveRegisteredWorktreePathMock.mockResolvedValue(resolvedWorktreePath)
    listRepoWorktreesMock.mockResolvedValue([{ path: resolvedWorktreePath }])
    createHostedReviewMock.mockResolvedValueOnce({
      ok: true,
      number: 42,
      url: 'https://github.com/acme/orca/pull/42'
    })

    registerHostedReviewHandlers(store as never, stats as never)

    await handlers['hostedReview:create'](null, {
      repoPath: localRepo.path,
      repoId: localRepo.id,
      worktreePath: '/workspace/feature',
      provider: 'github',
      base: 'main',
      head: 'feature/pr',
      title: 'Feature PR'
    })

    expect(listRepoWorktreesMock).toHaveBeenCalledWith(localRepo, { wslDistro: 'Ubuntu' })
    expect(createHostedReviewMock).toHaveBeenCalledWith(
      resolvedWorktreePath,
      expect.objectContaining({
        provider: 'github',
        head: 'feature/pr',
        title: 'Feature PR'
      }),
      null,
      { localGitExecOptions: { wslDistro: 'Ubuntu' } }
    )
  })

  it('routes local WSL project review status through main-process runtime options', async () => {
    setPlatform('win32')
    const localRepo = {
      id: 'repo-local',
      path: '/workspace/repo',
      displayName: 'local',
      badgeColor: '#000',
      addedAt: 0
    }
    store.getRepo.mockImplementation((repoId: string) =>
      repoId === localRepo.id ? localRepo : null
    )
    store.getRepos.mockReturnValue([localRepo])
    store.getProjects.mockReturnValue([
      {
        id: 'project-1',
        displayName: 'local',
        badgeColor: '#000',
        sourceRepoIds: [localRepo.id],
        localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' },
        createdAt: 0,
        updatedAt: 0
      }
    ])
    getHostedReviewForBranchMock.mockResolvedValueOnce({
      provider: 'github',
      number: 42,
      title: 'Feature PR',
      state: 'open',
      url: 'https://github.com/acme/orca/pull/42',
      status: 'success',
      updatedAt: '2026-06-16T00:00:00.000Z',
      mergeable: 'MERGEABLE'
    })

    registerHostedReviewHandlers(store as never, stats as never)

    await handlers['hostedReview:forBranch'](null, {
      repoPath: localRepo.path,
      repoId: localRepo.id,
      branch: 'feature/wsl',
      linkedGitHubPR: 42
    })

    expect(getHostedReviewForBranchMock).toHaveBeenCalledWith(
      expect.objectContaining({
        repoPath: localRepo.path,
        connectionId: undefined,
        branch: 'feature/wsl',
        linkedGitHubPR: 42,
        localGitExecOptions: { wslDistro: 'Ubuntu' }
      })
    )
  })

  it('passes SSH connectionId through create eligibility instead of blocking the worktree', async () => {
    getHostedReviewCreationEligibilityMock.mockResolvedValueOnce({
      provider: 'github',
      review: null,
      canCreate: true,
      blockedReason: null,
      nextAction: null,
      defaultBaseRef: 'main',
      head: 'feature/pr',
      title: 'Feature PR',
      body: null
    })

    registerHostedReviewHandlers(store as never, stats as never)

    await handlers['hostedReview:getCreationEligibility'](null, {
      repoPath,
      repoId: repo.id,
      worktreePath,
      branch: 'feature/pr',
      base: 'main'
    })

    expect(getHostedReviewCreationEligibilityMock).toHaveBeenCalledWith(
      expect.objectContaining({
        repoPath: worktreePath,
        connectionId: 'ssh-1',
        branch: 'feature/pr',
        base: 'main'
      })
    )
    expect(resolveRegisteredWorktreePathMock).not.toHaveBeenCalled()
  })

  it('passes SSH connectionId through pull request creation and records successful creates', async () => {
    createHostedReviewMock.mockResolvedValueOnce({
      ok: true,
      number: 42,
      url: 'https://github.com/acme/orca/pull/42'
    })

    registerHostedReviewHandlers(store as never, stats as never)

    await handlers['hostedReview:create'](null, {
      repoPath,
      repoId: repo.id,
      worktreePath,
      provider: 'github',
      base: 'main',
      head: 'feature/pr',
      title: 'Feature PR',
      body: null,
      draft: false
    })

    expect(createHostedReviewMock).toHaveBeenCalledWith(
      worktreePath,
      {
        provider: 'github',
        base: 'main',
        head: 'feature/pr',
        title: 'Feature PR',
        body: null,
        draft: false
      },
      'ssh-1'
    )
    expect(resolveRegisteredWorktreePathMock).not.toHaveBeenCalled()
    expect(stats.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'pr_created',
        repoId: 'repo-1',
        meta: { prNumber: 42, prUrl: 'https://github.com/acme/orca/pull/42' }
      })
    )
  })

  it('rejects creation when repoId and repoPath point at different registered repos', async () => {
    store.getRepo.mockImplementation((repoId: string) =>
      repoId === repo.id ? { ...repo, path: '/other/repo' } : null
    )

    registerHostedReviewHandlers(store as never, stats as never)

    await expect(
      handlers['hostedReview:create'](null, {
        repoPath,
        repoId: repo.id,
        worktreePath,
        provider: 'github',
        base: 'main',
        head: 'feature/pr',
        title: 'Feature PR'
      })
    ).rejects.toThrow('Access denied: unknown repository')

    expect(createHostedReviewMock).not.toHaveBeenCalled()
  })
})

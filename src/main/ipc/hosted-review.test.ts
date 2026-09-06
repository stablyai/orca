import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resolve } from 'node:path'

const ORIGINAL_PLATFORM = process.platform

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value: platform
  })
}

const {
  handleMock,
  createHostedReviewMock,
  createStackedHostedReviewMock,
  getHostedReviewCreationEligibilityMock,
  getHostedReviewForBranchMock,
  resolveRegisteredWorktreePathMock,
  listRepoWorktreeGraphMock
} = vi.hoisted(() => ({
  handleMock: vi.fn(),
  createHostedReviewMock: vi.fn(),
  createStackedHostedReviewMock: vi.fn(),
  getHostedReviewCreationEligibilityMock: vi.fn(),
  getHostedReviewForBranchMock: vi.fn(),
  resolveRegisteredWorktreePathMock: vi.fn(),
  listRepoWorktreeGraphMock: vi.fn()
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

vi.mock('../source-control/stacked-hosted-review-creation', () => ({
  createStackedHostedReview: createStackedHostedReviewMock
}))

vi.mock('../source-control/hosted-review', () => ({
  getHostedReviewForBranch: getHostedReviewForBranchMock
}))

vi.mock('./registered-worktree-roots-cache', () => ({
  resolveRegisteredWorktreePath: resolveRegisteredWorktreePathMock
}))

vi.mock('../repo-worktrees', () => ({
  listRepoWorktreeGraph: listRepoWorktreeGraphMock
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
    createStackedHostedReviewMock.mockReset()
    getHostedReviewCreationEligibilityMock.mockReset()
    getHostedReviewForBranchMock.mockReset()
    resolveRegisteredWorktreePathMock.mockReset()
    listRepoWorktreeGraphMock.mockReset()
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
    listRepoWorktreeGraphMock.mockResolvedValue([{ path: worktreePath }])
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
    listRepoWorktreeGraphMock.mockResolvedValue([{ path: resolvedWorktreePath }])
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

    expect(listRepoWorktreeGraphMock).toHaveBeenCalledWith(localRepo, { wslDistro: 'Ubuntu' })
    expect(createHostedReviewMock).toHaveBeenCalledWith(
      resolvedWorktreePath,
      expect.objectContaining({
        provider: 'github',
        head: 'feature/pr',
        title: 'Feature PR'
      }),
      'local',
      { localGitExecOptions: { wslDistro: 'Ubuntu', admissionTier: 'interactive' } }
    )
  })

  // Why: without this the dirty preflight counts Orca's own shared symlinks as
  // user work and Create Review tells the user to commit a link they cannot
  // commit (issue #10451). Nothing else asserts the handler supplies them.
  it('passes the repo shared link paths through local review creation', async () => {
    const localRepo = {
      id: 'repo-local',
      path: '/workspace/repo',
      displayName: 'local',
      badgeColor: '#000',
      addedAt: 0,
      symlinkPaths: ['node_modules']
    }
    store.getRepo.mockImplementation((repoId: string) =>
      repoId === localRepo.id ? localRepo : null
    )
    store.getRepos.mockReturnValue([localRepo])
    const resolvedWorktreePath = resolve('/workspace/feature')
    resolveRegisteredWorktreePathMock.mockResolvedValue(resolvedWorktreePath)
    listRepoWorktreeGraphMock.mockResolvedValue([{ path: resolvedWorktreePath }])
    createHostedReviewMock.mockResolvedValueOnce({ ok: true, number: 42, url: 'https://x/1' })

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

    expect(createHostedReviewMock).toHaveBeenCalledWith(
      resolvedWorktreePath,
      expect.anything(),
      'local',
      {
        localGitExecOptions: { admissionTier: 'interactive' },
        sharedLinkPaths: ['node_modules']
      }
    )
  })

  // Why: remote creation never materializes these links, and `repo.path` names a
  // path on the remote host — resolving it locally would read a stranger's file.
  it('does not resolve shared link paths for an SSH repo', async () => {
    store.getRepo.mockImplementation((repoId: string) =>
      repoId === repo.id ? { ...repo, symlinkPaths: ['node_modules'] } : null
    )
    createHostedReviewMock.mockResolvedValueOnce({ ok: true, number: 42, url: 'https://x/1' })

    registerHostedReviewHandlers(store as never, stats as never)

    await handlers['hostedReview:create'](null, {
      repoPath,
      repoId: repo.id,
      worktreePath,
      provider: 'github',
      base: 'main',
      head: 'feature/pr',
      title: 'Feature PR'
    })

    expect(createHostedReviewMock).toHaveBeenCalledWith(
      worktreePath,
      expect.anything(),
      'ssh:ssh-1',
      {
        localGitExecOptions: { admissionTier: 'interactive' }
      }
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
        executionHostId: 'local',
        branch: 'feature/wsl',
        linkedGitHubPR: 42,
        localGitExecOptions: { wslDistro: 'Ubuntu', admissionTier: 'background' }
      })
    )
    // Card-list polling is the O(N) tier and must not claim the fast one.
    expect(getHostedReviewForBranchMock.mock.calls[0][0]).not.toHaveProperty('active')
  })

  it('carries a selected-worktree claim through to the branch lookup', async () => {
    getHostedReviewForBranchMock.mockResolvedValueOnce(null)
    registerHostedReviewHandlers(store as never, stats as never)

    await handlers['hostedReview:forBranch'](null, {
      repoPath,
      repoId: repo.id,
      branch: 'feature/selected',
      active: true
    })

    // Why: the right sidebar renders only the selected worktree, so its lookup
    // earns the per-minute tier instead of the card-list interval (#11532).
    expect(getHostedReviewForBranchMock).toHaveBeenCalledWith(
      expect.objectContaining({ branch: 'feature/selected', active: true })
    )
  })

  it('uses interactive git admission for an explicit card refresh', async () => {
    getHostedReviewForBranchMock.mockResolvedValueOnce(null)
    registerHostedReviewHandlers(store as never, stats as never)

    await handlers['hostedReview:forBranch'](null, {
      repoPath,
      repoId: repo.id,
      branch: 'feature/refresh',
      admissionTier: 'interactive'
    })

    expect(getHostedReviewForBranchMock).toHaveBeenCalledWith(
      expect.objectContaining({
        branch: 'feature/refresh',
        localGitExecOptions: { admissionTier: 'interactive' }
      })
    )
  })

  it('uses the explicit owner when duplicate repos share an id and path', async () => {
    const localRepo = { ...repo, connectionId: undefined }
    store.getRepos.mockReturnValue([localRepo, repo])
    getHostedReviewForBranchMock.mockResolvedValueOnce(null)
    registerHostedReviewHandlers(store as never, stats as never)

    await handlers['hostedReview:forBranch'](null, {
      repoPath,
      repoId: repo.id,
      repoOwnerExecutionHostId: 'ssh:ssh-1',
      branch: 'feature/owner'
    })

    expect(getHostedReviewForBranchMock).toHaveBeenCalledWith(
      expect.objectContaining({ executionHostId: 'ssh:ssh-1', branch: 'feature/owner' })
    )
  })

  it('fails closed when an explicit repo owner is missing', async () => {
    registerHostedReviewHandlers(store as never, stats as never)

    await expect(
      handlers['hostedReview:forBranch'](null, {
        repoPath,
        repoId: repo.id,
        repoOwnerExecutionHostId: 'runtime:missing',
        branch: 'feature/owner'
      })
    ).rejects.toThrow('Access denied: unknown or ambiguous repository owner')
    expect(getHostedReviewForBranchMock).not.toHaveBeenCalled()
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
        executionHostId: 'ssh:ssh-1',
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
      'ssh:ssh-1',
      { localGitExecOptions: { admissionTier: 'interactive' } }
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

  it('routes stacked creation through its dedicated SSH-safe handler', async () => {
    createStackedHostedReviewMock.mockResolvedValueOnce({
      ok: true,
      number: 43,
      url: 'https://github.com/acme/orca/pull/43',
      stackNumber: 50,
      parentReview: { number: 42, url: 'https://github.com/acme/orca/pull/42' }
    })
    registerHostedReviewHandlers(store as never, stats as never)

    await handlers['hostedReview:createStacked'](null, {
      repoPath,
      repoId: repo.id,
      worktreePath,
      provider: 'github',
      base: 'stack/parent',
      head: 'stack/child',
      title: 'Child'
    })

    expect(createStackedHostedReviewMock).toHaveBeenCalledWith(
      worktreePath,
      expect.objectContaining({ base: 'stack/parent', head: 'stack/child' }),
      'ssh:ssh-1',
      { localGitExecOptions: { admissionTier: 'interactive' } }
    )
    expect(createHostedReviewMock).not.toHaveBeenCalled()
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

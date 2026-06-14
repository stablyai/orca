import { beforeEach, describe, expect, it, vi } from 'vitest'

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
  const repo = {
    id: 'repo-1',
    path: repoPath,
    displayName: 'repo',
    badgeColor: '#000',
    addedAt: 0,
    connectionId: 'ssh-1'
  }
  const store = {
    getRepo: vi.fn((repoId: string) => (repoId === repo.id ? repo : null)),
    getRepos: vi.fn(() => [repo])
  }
  const stats = {
    hasCountedPR: vi.fn(() => false),
    record: vi.fn()
  }

  beforeEach(() => {
    handleMock.mockReset()
    createHostedReviewMock.mockReset()
    getHostedReviewCreationEligibilityMock.mockReset()
    getHostedReviewForBranchMock.mockReset()
    resolveRegisteredWorktreePathMock.mockReset()
    listRepoWorktreesMock.mockReset()
    store.getRepo.mockClear()
    store.getRepos.mockClear()
    stats.hasCountedPR.mockClear()
    stats.record.mockClear()
    for (const key of Object.keys(handlers)) {
      delete handlers[key]
    }
    handleMock.mockImplementation((channel, handler) => {
      handlers[channel] = handler
    })
    listRepoWorktreesMock.mockResolvedValue([{ path: worktreePath }])
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

import { beforeEach, describe, expect, it, vi } from 'vitest'

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
  listRepoWorktreeGraphMock,
  readWslDistroRunningStateMock
} = vi.hoisted(() => ({
  handleMock: vi.fn(),
  createHostedReviewMock: vi.fn(),
  createStackedHostedReviewMock: vi.fn(),
  getHostedReviewCreationEligibilityMock: vi.fn(),
  getHostedReviewForBranchMock: vi.fn(),
  resolveRegisteredWorktreePathMock: vi.fn(),
  listRepoWorktreeGraphMock: vi.fn(),
  readWslDistroRunningStateMock: vi.fn()
}))

vi.mock('../../wsl/discovery/wsl-background-distro-gate', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readWslDistroRunningState: readWslDistroRunningStateMock
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: handleMock
  }
}))

vi.mock('../../source-control/hosted-review-creation', () => ({
  createHostedReview: createHostedReviewMock,
  getHostedReviewCreationEligibility: getHostedReviewCreationEligibilityMock
}))

vi.mock('../../source-control/stacked-hosted-review-creation', () => ({
  createStackedHostedReview: createStackedHostedReviewMock
}))

vi.mock('../../source-control/hosted-review', () => ({
  getHostedReviewForBranch: getHostedReviewForBranchMock,
  // Handlers read through this; keep asserting on the one mock.
  readHostedReviewForBranch: vi.fn(async (input: unknown) => ({
    review: await getHostedReviewForBranchMock(input),
    readOutcome: 'cached'
  }))
}))

vi.mock('../worktrees/removal/registered-worktree-roots-cache', () => ({
  resolveRegisteredWorktreePath: resolveRegisteredWorktreePathMock
}))

vi.mock('../../workspaces/catalog/repo-worktrees', () => ({
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
    readWslDistroRunningStateMock.mockReset().mockResolvedValue('running')
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

  // Shared symlinks belong to Orca and must not fail the user's dirty preflight (#10451).

  // Remote paths must not resolve unrelated local orca.yaml files.

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

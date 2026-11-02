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

vi.mock('../wsl-background-distro-gate', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readWslDistroRunningState: readWslDistroRunningStateMock
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
  getHostedReviewForBranch: getHostedReviewForBranchMock,
  // Handlers read through this; keep asserting on the one mock.
  readHostedReviewForBranch: vi.fn(async (input: unknown) => ({
    review: await getHostedReviewForBranchMock(input),
    readOutcome: 'cached'
  }))
}))

vi.mock('./registered-worktree-roots-cache', () => ({
  resolveRegisteredWorktreePath: resolveRegisteredWorktreePathMock
}))

vi.mock('../repo-worktrees', () => ({
  listRepoWorktreeGraph: listRepoWorktreeGraphMock
}))

import { registerHostedReviewHandlers } from './hosted-review'
import { readHostedReviewForBranch } from '../source-control/hosted-review'
import type { HostedReviewInfo } from '../../shared/hosted-review'
import { WslDistroStoppedError } from '../wsl/wsl-unc-access-gate'
import { WorktreeCatalogUnavailableError } from '../../shared/worktree/worktree-catalog-availability'

type HandlerMap = Record<string, (_event: unknown, args: unknown) => unknown>

const providerReview: HostedReviewInfo = {
  provider: 'gitlab',
  number: 7,
  title: 'MR',
  url: 'https://gitlab.example.test/g/p/-/merge_requests/7',
  state: 'open',
  status: 'success',
  mergeable: 'MERGEABLE',
  updatedAt: '2026-10-30'
}
// Only a caller that asks gets the outcome envelope; a definitive null keeps its outcome too.
const READ_OUTCOME_REPLIES = [
  { reportReadOutcome: true, review: providerReview },
  { reportReadOutcome: true, review: null },
  { reportReadOutcome: false, review: providerReview },
  { reportReadOutcome: undefined, review: null }
]

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

  // Shared symlinks belong to Orca and must not fail the user's dirty preflight (#10451).
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

  // Remote paths must not resolve unrelated local orca.yaml files.
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

  it('refuses a card poll for a stopped WSL distro without running gh or glab in it', async () => {
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
    readWslDistroRunningStateMock.mockResolvedValue('stopped')
    registerHostedReviewHandlers(store as never, stats as never)

    await expect(
      handlers['hostedReview:forBranch'](null, {
        repoPath: localRepo.path,
        repoId: localRepo.id,
        branch: 'feature/wsl',
        force: true
      })
    ).rejects.toBeInstanceOf(WslDistroStoppedError)
    expect(readWslDistroRunningStateMock).toHaveBeenCalledWith('Ubuntu', expect.anything())
    expect(getHostedReviewForBranchMock).not.toHaveBeenCalled()
  })

  it.each([
    [
      "refuses the visible scheduler's interactive-priority poll",
      { admissionTier: 'interactive' },
      0
    ],
    [
      'lets an explicit Refresh start the distro',
      { admissionTier: 'interactive', wakeWslDistro: true },
      1
    ]
  ] as const)('%s for a stopped distro', async (_case, extra, reads) => {
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
    readWslDistroRunningStateMock.mockResolvedValue('stopped')
    getHostedReviewForBranchMock.mockResolvedValue(null)
    registerHostedReviewHandlers(store as never, stats as never)

    const read = handlers['hostedReview:forBranch'](null, {
      repoPath: localRepo.path,
      repoId: localRepo.id,
      branch: 'feature/wsl',
      ...extra
    })

    await (reads === 0 ? expect(read).rejects.toBeInstanceOf(WslDistroStoppedError) : read)
    expect(getHostedReviewForBranchMock).toHaveBeenCalledTimes(reads)
  })

  it.each([
    ["refuses Source Control's mount-time eligibility read", {}, 0],
    ["lets the user's Create PR start the distro", { wakeWslDistro: true }, 1]
  ] as const)('%s for a stopped distro (E9)', async (_case, extra, reads) => {
    setPlatform('win32')
    const wslRepo = {
      id: 'repo-wsl',
      path: '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo',
      displayName: 'wsl',
      badgeColor: '#000',
      addedAt: 0
    }
    store.getRepo.mockImplementation((repoId: string) => (repoId === wslRepo.id ? wslRepo : null))
    store.getRepos.mockReturnValue([wslRepo])
    readWslDistroRunningStateMock.mockResolvedValue('stopped')
    getHostedReviewCreationEligibilityMock.mockResolvedValue({ canCreate: false })
    registerHostedReviewHandlers(store as never, stats as never)

    const read = handlers['hostedReview:getCreationEligibility'](null, {
      repoPath: wslRepo.path,
      repoId: wslRepo.id,
      branch: 'feature/wsl',
      ...extra
    })

    await (reads === 0 ? expect(read).rejects.toBeInstanceOf(WslDistroStoppedError) : read)
    expect(getHostedReviewCreationEligibilityMock).toHaveBeenCalledTimes(reads)
  })

  it('carries a selected-worktree claim and explicit refresh through, and replies with the outcome only when asked', async () => {
    getHostedReviewForBranchMock.mockResolvedValueOnce(null)
    registerHostedReviewHandlers(store as never, stats as never)

    await handlers['hostedReview:forBranch'](null, {
      repoPath,
      repoId: repo.id,
      branch: 'feature/selected',
      active: true,
      force: true,
      userRefresh: true
    })

    // Selected-worktree lookups use the faster active tier, unlike O(N) card polling (#11532).
    expect(getHostedReviewForBranchMock).toHaveBeenCalledWith(
      expect.objectContaining({
        branch: 'feature/selected',
        active: true,
        force: true,
        userRefresh: true
      })
    )

    for (const { reportReadOutcome, review } of READ_OUTCOME_REPLIES) {
      vi.mocked(readHostedReviewForBranch).mockResolvedValueOnce({
        review,
        readOutcome: 'provider'
      })
      const reply = await handlers['hostedReview:forBranch'](null, {
        repoPath,
        repoId: repo.id,
        branch: 'feature/selected',
        userRefresh: true,
        ...(reportReadOutcome === undefined ? {} : { reportReadOutcome })
      })
      expect(reply).toEqual(reportReadOutcome ? { review, readOutcome: 'provider' } : review)
    }
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

  it('reports an unreachable SSH host as unavailable, not as a foreign worktree', async () => {
    listRepoWorktreeGraphMock.mockRejectedValueOnce(
      new WorktreeCatalogUnavailableError(
        `Worktree catalog unavailable for ${repoPath}: SSH connection "ssh-1" is not connected.`
      )
    )
    registerHostedReviewHandlers(store as never, stats as never)

    const result = handlers['hostedReview:getCreationEligibility'](null, {
      repoPath,
      repoId: repo.id,
      worktreePath,
      branch: 'feature/pr',
      base: 'main'
    })

    await expect(result).rejects.toBeInstanceOf(WorktreeCatalogUnavailableError)
    await expect(result).rejects.not.toThrow('does not belong')
    expect(getHostedReviewCreationEligibilityMock).not.toHaveBeenCalled()
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

  // Electron and RPC routes must both honor the repo's bound gh account.
  describe('gh account binding', () => {
    const boundRepo = { ...repo, ghAccount: { host: 'github.com', user: 'octocat' } }

    beforeEach(() => {
      store.getRepo.mockImplementation((repoId: string) => (repoId === repo.id ? boundRepo : null))
      store.getRepos.mockReturnValue([boundRepo])
    })

    it('carries the bound account through creation, stacked creation and branch lookup', async () => {
      createHostedReviewMock.mockResolvedValueOnce({ ok: true, number: 42, url: 'https://x/42' })
      createStackedHostedReviewMock.mockResolvedValueOnce({
        ok: true,
        number: 43,
        url: 'https://x/43',
        stackNumber: 50,
        parentReview: { number: 42, url: 'https://x/42' }
      })
      getHostedReviewForBranchMock.mockResolvedValueOnce(null)
      registerHostedReviewHandlers(store as never, stats as never)

      const base = { repoPath, repoId: repo.id, worktreePath, provider: 'github', base: 'main' }
      await handlers['hostedReview:create'](null, { ...base, head: 'feature/pr', title: 'PR' })
      await handlers['hostedReview:createStacked'](null, {
        ...base,
        base: 'stack/parent',
        head: 'stack/child',
        title: 'Child'
      })
      await handlers['hostedReview:forBranch'](null, {
        repoPath,
        repoId: repo.id,
        branch: 'feature/pr'
      })

      const expected = {
        localGitExecOptions: expect.objectContaining({ ghAccount: boundRepo.ghAccount })
      }
      expect(createHostedReviewMock).toHaveBeenCalledWith(
        worktreePath,
        expect.anything(),
        'ssh:ssh-1',
        expected
      )
      expect(createStackedHostedReviewMock).toHaveBeenCalledWith(
        worktreePath,
        expect.anything(),
        'ssh:ssh-1',
        expected
      )
      expect(getHostedReviewForBranchMock).toHaveBeenCalledWith(expect.objectContaining(expected))
    })

    it('leaves an unbound repo on the ambient account', async () => {
      store.getRepo.mockImplementation((repoId: string) => (repoId === repo.id ? repo : null))
      store.getRepos.mockReturnValue([repo])
      getHostedReviewForBranchMock.mockResolvedValueOnce(null)
      registerHostedReviewHandlers(store as never, stats as never)

      await handlers['hostedReview:forBranch'](null, {
        repoPath,
        repoId: repo.id,
        branch: 'feature/pr'
      })

      expect(getHostedReviewForBranchMock.mock.calls[0][0].localGitExecOptions).not.toHaveProperty(
        'ghAccount'
      )
    })
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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import path from 'node:path'
import type { Store } from '../persistence'
import type * as RepoWorktreesModule from '../repo-worktrees'
import type { GitStatusResult } from '../../shared/git-status-types'
import type { Repo } from '../../shared/repo-types'
import type { GitWorktreeInfo } from '../../shared/worktree/types'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import { WORKSPACE_CLEANUP_TARGET_BATCH_LIMIT } from '../../shared/workspace-cleanup'

const {
  lstatMock,
  readFileMock,
  listRepoWorktreesMock,
  getStatusMock,
  gitExecFileAsyncMock,
  getLocalProjectWorktreeGitOptionsMock,
  getSshGitProviderMock
} = vi.hoisted(() => ({
  lstatMock: vi.fn(),
  readFileMock: vi.fn(),
  listRepoWorktreesMock: vi.fn(),
  getStatusMock: vi.fn(),
  gitExecFileAsyncMock: vi.fn(),
  getLocalProjectWorktreeGitOptionsMock: vi.fn(),
  getSshGitProviderMock: vi.fn()
}))

vi.mock('node:fs/promises', () => ({
  lstat: lstatMock,
  readFile: readFileMock
}))

vi.mock('../repo-worktrees', async () => {
  const actual = await vi.importActual<typeof RepoWorktreesModule>('../repo-worktrees')
  return {
    listRepoWorktrees: listRepoWorktreesMock,
    createFolderWorktree: actual.createFolderWorktree
  }
})

vi.mock('../git/status', () => ({
  getStatus: getStatusMock
}))

vi.mock('../git/runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock
}))

vi.mock('../providers/ssh-git-dispatch', () => ({
  getSshGitProvider: getSshGitProviderMock
}))

vi.mock('../project-runtime-git-options', () => ({
  getLocalProjectWorktreeGitOptions: getLocalProjectWorktreeGitOptionsMock
}))

import { scanWorkspaceCleanup } from './workspace-cleanup-scan'

const NOW = 1_700_000_000_000
const DAY_MS = 24 * 60 * 60 * 1000
const REPO: Repo = {
  id: 'repo-1',
  path: '/repo',
  displayName: 'Repo',
  badgeColor: '#000',
  addedAt: NOW,
  symlinkPaths: ['node_modules']
}
const FOLDER_REPO: Repo = {
  ...REPO,
  id: 'repo-folder',
  path: '/folder-workspace',
  displayName: 'Folder',
  kind: 'folder'
}

const GIT_WORKTREES: GitWorktreeInfo[] = [
  {
    path: '/repo',
    head: 'main123',
    branch: 'refs/heads/main',
    isBare: false,
    isMainWorktree: true
  },
  {
    path: '/repo-old',
    head: 'old123',
    branch: 'refs/heads/old',
    isBare: false,
    isMainWorktree: false
  },
  {
    path: '/repo-recent',
    head: 'recent123',
    branch: 'refs/heads/recent',
    isBare: false,
    isMainWorktree: false
  }
]

function makeWorktreeMeta(overrides: Partial<WorktreeMeta> = {}): WorktreeMeta {
  return {
    displayName: '',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: NOW,
    baseRef: 'origin/main',
    ...overrides
  } as WorktreeMeta
}

const META_BY_WORKTREE_ID: Record<string, WorktreeMeta> = {
  'repo-1::/repo': makeWorktreeMeta({ lastActivityAt: NOW - 40 * DAY_MS }),
  'repo-1::/repo-old': makeWorktreeMeta({ lastActivityAt: NOW - 40 * DAY_MS }),
  'repo-1::/repo-recent': makeWorktreeMeta({
    lastActivityAt: NOW - 2 * DAY_MS
  }),
  'repo-folder::/folder-workspace': makeWorktreeMeta({
    lastActivityAt: NOW - 40 * DAY_MS
  })
}

function makeStore(repos: Repo[] = [REPO], allMeta: Record<string, WorktreeMeta> = {}): Store {
  return {
    getRepos: () => repos,
    getWorktreeMeta: (worktreeId: string) => META_BY_WORKTREE_ID[worktreeId] ?? allMeta[worktreeId],
    getAllWorktreeMeta: () => allMeta,
    getGitHubCache: () => ({ pr: {}, issue: {} })
  } as unknown as Store
}

describe('workspace cleanup broad scan opt-in', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    lstatMock.mockReset().mockResolvedValue({ mtimeMs: 0 })
    readFileMock.mockReset().mockRejectedValue(new Error('not a gitdir pointer'))
    listRepoWorktreesMock.mockReset().mockResolvedValue(GIT_WORKTREES)
    getStatusMock.mockReset().mockResolvedValue({
      entries: [],
      conflictOperation: 'unknown',
      upstreamStatus: { hasUpstream: true, ahead: 0, behind: 0 }
    } satisfies GitStatusResult)
    gitExecFileAsyncMock.mockReset().mockResolvedValue({ stdout: '0\n', stderr: '' })
    getLocalProjectWorktreeGitOptionsMock.mockReset().mockReturnValue({})
    getSshGitProviderMock.mockReset().mockReturnValue(undefined)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('emits every worktree when the client opts into the full workspace list', async () => {
    const result = await scanWorkspaceCleanup(makeStore(), {
      includeAllWorkspaces: true
    })

    expect(result.errors).toEqual([])
    expect(result.candidates.map((candidate) => candidate.worktreeId)).toEqual([
      'repo-1::/repo',
      'repo-1::/repo-old',
      'repo-1::/repo-recent'
    ])
  })

  it('preserves a worktree runtime host on cleanup candidates', async () => {
    const runtimeMeta = makeWorktreeMeta({
      lastActivityAt: NOW - 40 * DAY_MS,
      hostId: 'runtime:env-1'
    })
    const store = {
      ...makeStore(),
      getWorktreeMeta: (worktreeId: string) =>
        worktreeId === 'repo-1::/repo-old' ? runtimeMeta : META_BY_WORKTREE_ID[worktreeId]
    } as unknown as Store

    const result = await scanWorkspaceCleanup(store, {
      includeAllWorkspaces: true
    })

    expect(
      result.candidates.find((candidate) => candidate.worktreeId === 'repo-1::/repo-old')
        ?.executionHostId
    ).toBe('runtime:env-1')
  })

  it('does not borrow same-id local metadata for a connected SSH cleanup row', async () => {
    const sharedPath = '/shared/workspace'
    const worktreeId = `${REPO.id}::${sharedPath}`
    const localRepo = { ...REPO, path: '/local/repo' }
    const sshRepo = { ...REPO, path: '/remote/repo', connectionId: 'ssh-1' }
    const sharedWorktree: GitWorktreeInfo = {
      path: sharedPath,
      head: 'shared123',
      branch: 'refs/heads/shared',
      isBare: false,
      isMainWorktree: false
    }
    const localMeta = makeWorktreeMeta({
      displayName: 'Local metadata only',
      hostId: 'local',
      isPinned: true,
      lastActivityAt: NOW - 40 * DAY_MS
    })
    listRepoWorktreesMock.mockResolvedValue([sharedWorktree])
    getSshGitProviderMock.mockReturnValue({
      listWorktrees: vi.fn().mockResolvedValue([sharedWorktree])
    })

    const result = await scanWorkspaceCleanup(
      makeStore([localRepo, sshRepo], { [worktreeId]: localMeta }),
      { includeAllWorkspaces: true, skipGitWorktreeIds: [worktreeId] }
    )

    expect(result.candidates).toHaveLength(2)
    expect(result.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          worktreeId,
          executionHostId: 'local',
          displayName: 'Local metadata only',
          blockers: ['pinned']
        }),
        expect.objectContaining({
          worktreeId,
          executionHostId: 'ssh:ssh-1',
          displayName: 'shared',
          blockers: []
        })
      ])
    )
  })

  it('reads git for a pinned target during focused preflight scans', async () => {
    const worktreeId = 'repo-1::/repo-old'
    const pinnedMeta = makeWorktreeMeta({
      isPinned: true,
      lastActivityAt: NOW - 40 * DAY_MS
    })
    const store = {
      ...makeStore(),
      getWorktreeMeta: (id: string) => (id === worktreeId ? pinnedMeta : META_BY_WORKTREE_ID[id])
    } as Store

    const result = await scanWorkspaceCleanup(store, {
      worktreeIds: [worktreeId],
      refreshActivity: true
    })

    expect(result.candidates[0]?.blockers).toContain('pinned')
    expect(getStatusMock).toHaveBeenCalledTimes(1)
  })

  it('continues to skip pinned git reads during broad scans', async () => {
    const worktreeId = 'repo-1::/repo-old'
    const pinnedMeta = makeWorktreeMeta({
      isPinned: true,
      lastActivityAt: NOW - 40 * DAY_MS
    })
    const store = {
      ...makeStore(),
      getWorktreeMeta: (id: string) => (id === worktreeId ? pinnedMeta : META_BY_WORKTREE_ID[id])
    } as Store
    listRepoWorktreesMock.mockResolvedValue([GIT_WORKTREES[1]])

    await scanWorkspaceCleanup(store, { includeAllWorkspaces: true })

    expect(getStatusMock).not.toHaveBeenCalled()
  })

  it('qualifies targeted repo-list failures with the execution host', async () => {
    listRepoWorktreesMock.mockRejectedValue(new Error('listing failed'))

    const result = await scanWorkspaceCleanup(makeStore(), {
      worktreeIds: ['repo-1::/repo-old'],
      refreshActivity: true
    })

    expect(result.errors).toEqual([
      expect.objectContaining({ repoId: 'repo-1', executionHostId: 'local' })
    ])
  })

  it('keeps the legacy suggestion-only projection when the flag is absent', async () => {
    const result = await scanWorkspaceCleanup(makeStore())

    expect(result.candidates.map((candidate) => candidate.worktreeId)).toEqual([
      'repo-1::/repo-old'
    ])
  })

  it('reports recent workspaces with no cleanup reasons', async () => {
    const result = await scanWorkspaceCleanup(makeStore(), {
      includeAllWorkspaces: true
    })

    const recent = result.candidates.find(
      (candidate) => candidate.worktreeId === 'repo-1::/repo-recent'
    )
    expect(recent).toMatchObject({
      reasons: [],
      tier: 'review',
      selectedByDefault: false,
      lastActivityAt: NOW - 2 * DAY_MS
    })
  })

  it('reports the main worktree with a main-worktree blocker', async () => {
    const result = await scanWorkspaceCleanup(makeStore(), {
      includeAllWorkspaces: true
    })

    const main = result.candidates.find((candidate) => candidate.worktreeId === 'repo-1::/repo')
    expect(main).toMatchObject({
      tier: 'protected',
      selectedByDefault: false,
      blockers: ['main-worktree']
    })
  })

  it('reports folder workspaces with a folder-repo blocker', async () => {
    const instanceId = `${FOLDER_REPO.id}::${FOLDER_REPO.path}::workspace:11111111-2222-4333-8444-555555555555`
    const instanceMeta = makeWorktreeMeta({
      displayName: 'Folder session',
      lastActivityAt: NOW - 2 * DAY_MS
    })
    const result = await scanWorkspaceCleanup(
      makeStore([FOLDER_REPO], { [instanceId]: instanceMeta }),
      { includeAllWorkspaces: true }
    )

    expect(result.candidates).toEqual([
      expect.objectContaining({
        worktreeId: 'repo-folder::/folder-workspace',
        tier: 'protected',
        selectedByDefault: false,
        blockers: expect.arrayContaining(['folder-repo', 'main-worktree'])
      }),
      expect.objectContaining({
        worktreeId: instanceId,
        displayName: 'Folder session',
        path: FOLDER_REPO.path,
        tier: 'protected',
        selectedByDefault: false,
        blockers: ['folder-repo']
      })
    ])
  })

  it('does not publish a same-id local folder instance on an SSH host', async () => {
    const localFolderRepo = { ...FOLDER_REPO }
    const sshFolderRepo = { ...FOLDER_REPO, connectionId: 'ssh-1' }
    const instanceId = `${FOLDER_REPO.id}::${FOLDER_REPO.path}::workspace:11111111-2222-4333-8444-555555555555`
    getSshGitProviderMock.mockReturnValue({})

    const result = await scanWorkspaceCleanup(
      makeStore([localFolderRepo, sshFolderRepo], {
        [instanceId]: makeWorktreeMeta({
          displayName: 'Local folder session',
          hostId: 'local'
        })
      }),
      { includeAllWorkspaces: true }
    )

    expect(result.candidates).toHaveLength(3)
    expect(result.candidates.filter((candidate) => candidate.worktreeId === instanceId)).toEqual([
      expect.objectContaining({
        executionHostId: 'local',
        displayName: 'Local folder session'
      })
    ])
  })

  it('does not mark connected SSH folder workspaces as disconnected', async () => {
    const sshFolderRepo: Repo = { ...FOLDER_REPO, connectionId: 'ssh-1' }
    getSshGitProviderMock.mockReturnValue({})

    const result = await scanWorkspaceCleanup(makeStore([sshFolderRepo]), {
      includeAllWorkspaces: true
    })

    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0]).toMatchObject({
      worktreeId: 'repo-folder::/folder-workspace',
      connectionId: 'ssh-1',
      blockers: ['main-worktree', 'folder-repo']
    })
  })

  it('defers git evidence for rows that no cleanup decision can use', async () => {
    const result = await scanWorkspaceCleanup(makeStore(), {
      includeAllWorkspaces: true
    })

    // Why: only the inactive row can ever be queued, so it is the only row worth
    // a git read; the rest stream immediately with empty evidence.
    expect(getStatusMock).toHaveBeenCalledTimes(1)
    expect(getStatusMock).toHaveBeenCalledWith('/repo-old', expect.anything())
    expect(
      result.candidates.find((candidate) => candidate.worktreeId === 'repo-1::/repo-recent')?.git
    ).toEqual({
      clean: null,
      upstreamAhead: null,
      upstreamBehind: null,
      checkedAt: null
    })
    expect(
      result.candidates.find((candidate) => candidate.worktreeId === 'repo-1::/repo-old')?.git
    ).toMatchObject({ clean: true, checkedAt: expect.any(Number) })
  })

  it('does not read activity files for rows already known to be recent', async () => {
    const recentWorktrees = ['/repo-recent-a', '/repo-recent-b'].map(
      (worktreePath, index): GitWorktreeInfo => ({
        path: worktreePath,
        head: `recent-${index}`,
        branch: `refs/heads/recent-${index}`,
        isBare: false,
        isMainWorktree: false
      })
    )
    listRepoWorktreesMock.mockResolvedValue(recentWorktrees)
    const recentMeta = makeWorktreeMeta({ lastActivityAt: NOW - 2 * DAY_MS })
    const store = {
      ...makeStore(),
      getWorktreeMeta: () => recentMeta
    } as unknown as Store

    const result = await scanWorkspaceCleanup(store, {
      includeAllWorkspaces: true
    })

    expect(result.candidates).toHaveLength(recentWorktrees.length)
    expect(readFileMock).not.toHaveBeenCalled()
    expect(lstatMock).not.toHaveBeenCalled()
    expect(getStatusMock).not.toHaveBeenCalled()
  })

  it('batches fleet progress instead of emitting one IPC payload per row', async () => {
    const worktrees = [
      GIT_WORKTREES[0],
      ...Array.from({ length: 200 }, (_, index): GitWorktreeInfo => ({
        path: `/repo-batch-${index}`,
        head: `head-${index}`,
        branch: `refs/heads/batch-${index}`,
        isBare: false,
        isMainWorktree: false
      }))
    ]
    listRepoWorktreesMock.mockResolvedValue(worktrees)
    const onProgress = vi.fn()

    const result = await scanWorkspaceCleanup(
      makeStore(),
      {
        scanId: 'fleet-scan',
        includeAllWorkspaces: true,
        skipGitWorktreeIds: worktrees.map((worktree) => `${REPO.id}::${worktree.path}`)
      },
      { onProgress }
    )

    expect(onProgress.mock.calls.length).toBeLessThanOrEqual(2)
    const progress = onProgress.mock.lastCall?.[0]
    expect(progress).toMatchObject({
      scannedWorktreeCount: result.candidates.length,
      totalWorktreeCount: result.candidates.length,
      candidateMode: 'append'
    })
    const streamedCandidates = onProgress.mock.calls.flatMap(([update]) => update.candidates)
    expect(streamedCandidates.map((candidate) => candidate.worktreeId)).toEqual(
      result.candidates.map((candidate) => candidate.worktreeId)
    )
  })

  it('still forces a git read for a focused scan of a recent workspace', async () => {
    const result = await scanWorkspaceCleanup(makeStore(), {
      worktreeId: 'repo-1::/repo-recent',
      includeAllWorkspaces: true
    })

    expect(getStatusMock).toHaveBeenCalledTimes(1)
    expect(lstatMock).toHaveBeenCalledWith('/repo-recent')
    expect(lstatMock).toHaveBeenCalledWith(path.join('/repo-recent', '.git'))
    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0]).toMatchObject({
      worktreeId: 'repo-1::/repo-recent',
      reasons: [],
      git: { clean: true, checkedAt: expect.any(Number) }
    })
  })

  it('lists a repo once for a targeted Git-evidence batch', async () => {
    const targets = ['repo-1::/repo-recent', 'repo-1::/repo-old']

    const result = await scanWorkspaceCleanup(makeStore(), {
      worktreeIds: targets
    })

    expect(listRepoWorktreesMock).toHaveBeenCalledTimes(1)
    expect(getStatusMock).toHaveBeenCalledTimes(2)
    expect(lstatMock).not.toHaveBeenCalled()
    expect(new Set(result.candidates.map((candidate) => candidate.worktreeId))).toEqual(
      new Set(targets)
    )
  })

  it('keeps the maximum targeted batch to one repo listing', async () => {
    const worktrees = Array.from(
      { length: WORKSPACE_CLEANUP_TARGET_BATCH_LIMIT + 1 },
      (_, index): GitWorktreeInfo => ({
        path: `/repo-evidence-${index}`,
        head: `head-${index}`,
        branch: `refs/heads/evidence-${index}`,
        isBare: false,
        isMainWorktree: false
      })
    )
    listRepoWorktreesMock.mockResolvedValue(worktrees)

    const result = await scanWorkspaceCleanup(makeStore(), {
      worktreeIds: worktrees.map((worktree) => `${REPO.id}::${worktree.path}`)
    })

    expect(result.candidates).toHaveLength(WORKSPACE_CLEANUP_TARGET_BATCH_LIMIT)
    expect(listRepoWorktreesMock).toHaveBeenCalledTimes(1)
    expect(getStatusMock).toHaveBeenCalledTimes(WORKSPACE_CLEANUP_TARGET_BATCH_LIMIT)
    expect(lstatMock).not.toHaveBeenCalled()
  })

  it('lists disconnected SSH workspaces only on an opt-in scan', async () => {
    const sshRepo: Repo = { ...REPO, id: 'repo-ssh', connectionId: 'ssh-1' }
    const allMeta: Record<string, WorktreeMeta> = {
      'repo-ssh::/remote/recent': makeWorktreeMeta({
        lastActivityAt: NOW - 2 * DAY_MS
      })
    }

    const legacy = await scanWorkspaceCleanup(makeStore([sshRepo], allMeta))
    const optIn = await scanWorkspaceCleanup(makeStore([sshRepo], allMeta), {
      includeAllWorkspaces: true
    })

    expect(legacy.candidates).toEqual([])
    expect(optIn.candidates).toHaveLength(1)
    expect(optIn.candidates[0]).toMatchObject({
      worktreeId: 'repo-ssh::/remote/recent',
      blockers: ['ssh-disconnected'],
      reasons: []
    })
  })

  it('keeps a canonical-only SSH cleanup row blocked while local metadata collides', async () => {
    const worktreeId = 'repo-1::/shared/workspace'
    const localRepo = { ...REPO, path: '/local/repo' }
    const sshRepo = { ...REPO, path: '/remote/repo', connectionId: 'ssh-1' }
    const localMeta = makeWorktreeMeta({
      displayName: 'Local workspace',
      hostId: 'local'
    })
    const remoteMeta = makeWorktreeMeta({
      displayName: 'Canonical remote workspace',
      hostId: 'ssh:ssh-1'
    })
    const store = {
      ...makeStore([localRepo, sshRepo], { [worktreeId]: localMeta }),
      getAllWorktreeMetaForHost: (hostId: string) =>
        hostId === 'ssh:ssh-1' ? { [worktreeId]: remoteMeta } : { [worktreeId]: localMeta }
    } as unknown as Store

    const result = await scanWorkspaceCleanup(store, { includeAllWorkspaces: true })

    expect(result.candidates).toContainEqual(
      expect.objectContaining({
        worktreeId,
        displayName: 'Canonical remote workspace',
        executionHostId: 'ssh:ssh-1',
        blockers: ['ssh-disconnected']
      })
    )
  })

  it('does not synthesize a disconnected SSH row from same-id local metadata', async () => {
    const sharedPath = '/shared/workspace'
    const worktreeId = `${REPO.id}::${sharedPath}`
    const localRepo = { ...REPO, path: '/local/repo' }
    const sshRepo = { ...REPO, path: '/remote/repo', connectionId: 'ssh-1' }
    const sharedWorktree: GitWorktreeInfo = {
      path: sharedPath,
      head: 'shared123',
      branch: 'refs/heads/shared',
      isBare: false,
      isMainWorktree: false
    }
    listRepoWorktreesMock.mockResolvedValue([sharedWorktree])

    const result = await scanWorkspaceCleanup(
      makeStore([localRepo, sshRepo], {
        [worktreeId]: makeWorktreeMeta({ hostId: 'local' })
      }),
      { includeAllWorkspaces: true, skipGitWorktreeIds: [worktreeId] }
    )

    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0]).toMatchObject({
      worktreeId,
      executionHostId: 'local'
    })
  })

  it('uses the backing path for disconnected SSH folder instances', async () => {
    const sshFolderRepo: Repo = { ...FOLDER_REPO, connectionId: 'ssh-1' }
    const instanceId = `${sshFolderRepo.id}::${sshFolderRepo.path}::workspace:11111111-2222-4333-8444-555555555555`
    const allMeta = {
      [instanceId]: makeWorktreeMeta({ displayName: 'Remote folder session' })
    }

    const result = await scanWorkspaceCleanup(makeStore([sshFolderRepo], allMeta), {
      includeAllWorkspaces: true
    })

    expect(result.candidates).toEqual([
      expect.objectContaining({
        worktreeId: instanceId,
        path: sshFolderRepo.path,
        branch: 'folder-workspace',
        blockers: ['ssh-disconnected']
      })
    ])
  })

  it('streams every row through scan progress on an opt-in scan', async () => {
    const progress: {
      scannedWorktreeCount: number
      totalWorktreeCount: number
    }[] = []

    await scanWorkspaceCleanup(
      makeStore(),
      { includeAllWorkspaces: true, scanId: 'scan-all' },
      { onProgress: (event) => progress.push(event) }
    )

    expect(progress.at(-1)).toMatchObject({
      scanId: 'scan-all',
      scannedWorktreeCount: 3,
      totalWorktreeCount: 3
    })
  })
})

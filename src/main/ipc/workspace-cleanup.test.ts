/* eslint-disable max-lines -- Why: scan and IPC process-liveness tests share
   hoisted Electron/git provider mocks; splitting would duplicate brittle setup. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'
import type { Store } from '../persistence'
import type {
  DiffComment,
  GitStatusResult,
  GitWorktreeInfo,
  Repo,
  WorktreeMeta
} from '../../shared/types'
import type { WorkspaceCleanupScanProgress } from '../../shared/workspace-cleanup'

const {
  listRepoWorktreesMock,
  getStatusMock,
  gitExecFileAsyncMock,
  getSshGitProviderMock,
  getSshPtyProviderMock,
  listRegisteredPtysMock
} = vi.hoisted(() => ({
  listRepoWorktreesMock: vi.fn(),
  getStatusMock: vi.fn(),
  gitExecFileAsyncMock: vi.fn(),
  getSshGitProviderMock: vi.fn(),
  getSshPtyProviderMock: vi.fn(),
  listRegisteredPtysMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
    removeHandler: vi.fn()
  }
}))

vi.mock('../repo-worktrees', () => ({
  listRepoWorktrees: listRepoWorktreesMock,
  createFolderWorktree: vi.fn()
}))

vi.mock('../git/status', () => ({
  getStatus: getStatusMock
}))

vi.mock('../git/runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock
}))

vi.mock('../providers/ssh-git-dispatch', () => ({
  getSshGitProvider: getSshGitProviderMock
}))

vi.mock('../memory/pty-registry', () => ({
  listRegisteredPtys: listRegisteredPtysMock
}))

vi.mock('./pty', () => ({
  getSshPtyProvider: getSshPtyProviderMock
}))

import { registerWorkspaceCleanupHandlers, scanWorkspaceCleanup } from './workspace-cleanup'

const NOW = 1_700_000_000_000
const REPO: Repo = {
  id: 'repo-1',
  path: '/repo',
  displayName: 'Repo',
  badgeColor: '#000',
  addedAt: NOW
}
const LARGE_WORKTREE_COUNT = 150_000

function buildGitWorktrees(count: number): GitWorktreeInfo[] {
  const worktrees: GitWorktreeInfo[] = []
  for (let index = 0; index < count; index += 1) {
    worktrees.push({
      path: `/repo-feature-${index}`,
      head: `abc${index}`,
      branch: `refs/heads/feature-${index}`,
      isBare: false,
      isMainWorktree: false
    })
  }
  return worktrees
}

function buildWorktreeIds(repoId: string, count: number): string[] {
  const worktreeIds: string[] = []
  for (let index = 0; index < count; index += 1) {
    worktreeIds.push(`${repoId}::/repo-feature-${index}`)
  }
  return worktreeIds
}

function makeStore(
  options: {
    baseRef?: string
    diffComments?: DiffComment[]
    lastActivityAt?: number
    linkedIssue?: number | null
    repos?: Repo[]
  } = {}
): Store {
  const baseRef = Object.hasOwn(options, 'baseRef') ? options.baseRef : 'origin/main'
  return {
    getRepos: () => options.repos ?? [REPO],
    getWorktreeMeta: () => ({
      linkedPR: null,
      linkedIssue: options.linkedIssue ?? null,
      lastActivityAt: options.lastActivityAt ?? NOW - 40 * 24 * 60 * 60 * 1000,
      baseRef,
      diffComments: options.diffComments
    }),
    getAllWorktreeMeta: () => ({}),
    getGitHubCache: () => ({
      pr: {},
      issue: {}
    })
  } as unknown as Store
}

describe('workspace cleanup scan', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    listRepoWorktreesMock.mockReset()
    getStatusMock.mockReset()
    gitExecFileAsyncMock.mockReset()
    getSshGitProviderMock.mockReset()
    getSshPtyProviderMock.mockReset()
    listRegisteredPtysMock.mockReset()
    listRegisteredPtysMock.mockReturnValue([])
    vi.mocked(ipcMain.handle).mockReset()
    vi.mocked(ipcMain.removeHandler).mockReset()
    listRepoWorktreesMock.mockResolvedValue([
      {
        path: '/repo-feature',
        head: 'abc123',
        branch: 'refs/heads/feature',
        isBare: false,
        isMainWorktree: false
      }
    ])
    getStatusMock.mockResolvedValue({
      entries: [],
      conflictOperation: 'unknown',
      upstreamStatus: { hasUpstream: true, ahead: 0, behind: 0 }
    } satisfies GitStatusResult)
    gitExecFileAsyncMock.mockResolvedValue({ stdout: '0\n', stderr: '' })
    getSshGitProviderMock.mockReturnValue(undefined)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('default-selects inactive workspaces when git status is clean', async () => {
    const result = await scanWorkspaceCleanup(makeStore())

    expect(getStatusMock).toHaveBeenCalledTimes(1)
    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0]).toMatchObject({
      tier: 'ready',
      selectedByDefault: true,
      reasons: ['idle-clean'],
      git: {
        clean: true,
        upstreamAhead: 0
      }
    })
  })

  it('reports cleanup scan progress as inactive workspaces are checked', async () => {
    listRepoWorktreesMock.mockResolvedValue([
      {
        path: '/repo-feature-a',
        head: 'abc123',
        branch: 'refs/heads/feature-a',
        isBare: false,
        isMainWorktree: false
      },
      {
        path: '/repo-feature-b',
        head: 'def456',
        branch: 'refs/heads/feature-b',
        isBare: false,
        isMainWorktree: false
      }
    ])
    const progress: unknown[] = []

    const result = await scanWorkspaceCleanup(
      makeStore(),
      { scanId: 'scan-1' },
      { onProgress: (event) => progress.push(event) }
    )

    expect(result.candidates).toHaveLength(2)
    expect(progress[0]).toMatchObject({
      scanId: 'scan-1',
      scannedWorktreeCount: 0,
      totalWorktreeCount: 2,
      candidates: []
    })
    const candidateProgress = progress.filter(
      (event): event is WorkspaceCleanupScanProgress =>
        (event as WorkspaceCleanupScanProgress).candidateMode === 'append' &&
        (event as WorkspaceCleanupScanProgress).candidates.length > 0
    )
    expect(candidateProgress).toHaveLength(2)
    expect(candidateProgress.every((event) => event.candidates.length === 1)).toBe(true)
    const progressWorktreeIds = candidateProgress.flatMap((event) =>
      event.candidates.map((candidate) => candidate.worktreeId)
    )
    expect(progressWorktreeIds).toEqual(
      expect.arrayContaining(['repo-1::/repo-feature-a', 'repo-1::/repo-feature-b'])
    )
    expect(progress.at(-1)).toMatchObject({
      scanId: 'scan-1',
      scannedWorktreeCount: 2,
      totalWorktreeCount: 2
    })
  })

  it('keeps raw scan errors out of renderer-facing results', async () => {
    listRepoWorktreesMock.mockRejectedValue(new Error('fatal: path /Users/alice/private failed'))

    const result = await scanWorkspaceCleanup(makeStore())

    expect(result.errors).toEqual([
      {
        repoId: 'repo-1',
        repoName: 'Repo',
        message: 'Git could not list worktrees.'
      }
    ])
  })

  it('aborts a hung worktree list when the cleanup timeout fires', async () => {
    let signal: AbortSignal | undefined
    listRepoWorktreesMock.mockImplementation((_repo: Repo, options?: { signal?: AbortSignal }) => {
      signal = options?.signal
      return new Promise<GitWorktreeInfo[]>(() => {})
    })

    const scan = scanWorkspaceCleanup(makeStore())
    await vi.advanceTimersByTimeAsync(8_000)

    await expect(scan).resolves.toEqual({
      scannedAt: NOW,
      candidates: [],
      errors: [
        {
          repoId: 'repo-1',
          repoName: 'Repo',
          message: 'Timed out listing worktrees.'
        }
      ]
    })
    expect(signal?.aborted).toBe(true)
  })

  it('skips disconnected remote workspaces without a scan warning', async () => {
    const result = await scanWorkspaceCleanup(
      makeStore({
        repos: [{ ...REPO, connectionId: 'ssh-1' }]
      })
    )

    expect(result.errors).toEqual([])
    expect(result.candidates).toEqual([])
  })

  it('uses direct metadata lookup for focused disconnected remote preflight', async () => {
    const targetWorktreeId = 'repo-1::/remote/repo-feature'
    const targetMeta: WorktreeMeta = {
      displayName: 'Remote Feature',
      comment: '',
      linkedIssue: null,
      linkedPR: null,
      linkedLinearIssue: null,
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: NOW - 2 * 24 * 60 * 60 * 1000
    }
    const getWorktreeMeta = vi.fn((worktreeId: string) =>
      worktreeId === targetWorktreeId ? targetMeta : undefined
    )
    const getAllWorktreeMeta = vi.fn(() => {
      throw new Error('focused disconnected SSH preflight should not enumerate all metadata')
    })
    const store = {
      getRepos: () => [{ ...REPO, connectionId: 'ssh-1' }],
      getWorktreeMeta,
      getAllWorktreeMeta
    } as unknown as Store

    const result = await scanWorkspaceCleanup(store, { worktreeId: targetWorktreeId })

    expect(getWorktreeMeta).toHaveBeenCalledWith(targetWorktreeId)
    expect(getAllWorktreeMeta).not.toHaveBeenCalled()
    expect(result.errors).toEqual([])
    expect(result.candidates[0]).toMatchObject({
      worktreeId: targetWorktreeId,
      path: '/remote/repo-feature',
      blockers: ['ssh-disconnected'],
      git: {
        clean: null,
        checkedAt: null
      }
    })
  })

  it('scans connected remote workspaces through the SSH git provider', async () => {
    const provider = {
      listWorktrees: vi.fn().mockResolvedValue([
        {
          path: '/remote/repo-feature',
          head: 'abc123',
          branch: 'refs/heads/feature',
          isBare: false,
          isMainWorktree: false
        }
      ]),
      getStatus: vi.fn().mockResolvedValue({
        entries: [],
        conflictOperation: 'unknown',
        upstreamStatus: { hasUpstream: true, ahead: 0, behind: 0 }
      } satisfies GitStatusResult)
    }
    getSshGitProviderMock.mockReturnValue(provider)

    const result = await scanWorkspaceCleanup(
      makeStore({
        repos: [{ ...REPO, connectionId: 'ssh-1' }]
      })
    )

    expect(provider.listWorktrees).toHaveBeenCalledWith('/repo', {
      signal: expect.any(AbortSignal)
    })
    expect(provider.getStatus).toHaveBeenCalledWith('/remote/repo-feature', {
      signal: expect.any(AbortSignal)
    })
    expect(result.errors).toEqual([])
    expect(result.candidates[0]).toMatchObject({
      connectionId: 'ssh-1',
      tier: 'ready',
      selectedByDefault: true,
      reasons: ['idle-clean']
    })
  })

  it('skips connected remote workspaces that fail during broad scans', async () => {
    const provider = {
      listWorktrees: vi.fn().mockRejectedValue(new Error('ssh timeout')),
      getStatus: vi.fn()
    }
    getSshGitProviderMock.mockReturnValue(provider)

    const result = await scanWorkspaceCleanup(
      makeStore({
        repos: [{ ...REPO, connectionId: 'ssh-1' }]
      })
    )

    expect(provider.listWorktrees).toHaveBeenCalledWith('/repo', {
      signal: expect.any(AbortSignal)
    })
    expect(result.errors).toEqual([])
    expect(result.candidates).toEqual([])
  })

  it('filters out recent workspaces before running git status', async () => {
    const result = await scanWorkspaceCleanup(
      makeStore({
        lastActivityAt: NOW - 2 * 24 * 60 * 60 * 1000
      })
    )

    expect(getStatusMock).not.toHaveBeenCalled()
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
    expect(result.candidates).toEqual([])
  })

  it('includes focused remove preflight rows even when they are recent', async () => {
    const result = await scanWorkspaceCleanup(
      makeStore({
        lastActivityAt: NOW - 2 * 24 * 60 * 60 * 1000
      }),
      { worktreeId: 'repo-1::/repo-feature' }
    )

    expect(getStatusMock).toHaveBeenCalledTimes(1)
    expect(result.candidates[0]).toMatchObject({
      tier: 'review',
      selectedByDefault: false,
      reasons: [],
      git: {
        clean: true,
        checkedAt: expect.any(Number)
      }
    })
  })

  it('only inspects the target repo during focused scans', async () => {
    const repoTwo = { ...REPO, id: 'repo-2', path: '/repo-two', displayName: 'Repo Two' }
    listRepoWorktreesMock.mockImplementation((repo: Repo) =>
      Promise.resolve([
        {
          path: `${repo.path}-feature`,
          head: 'abc123',
          branch: 'refs/heads/feature',
          isBare: false,
          isMainWorktree: false
        }
      ])
    )

    const result = await scanWorkspaceCleanup(
      makeStore({
        repos: [REPO, repoTwo]
      }),
      { worktreeId: 'repo-2::/repo-two-feature' }
    )

    expect(listRepoWorktreesMock).toHaveBeenCalledTimes(1)
    expect(listRepoWorktreesMock).toHaveBeenCalledWith(repoTwo, {
      signal: expect.any(AbortSignal)
    })
    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0]).toMatchObject({
      worktreeId: 'repo-2::/repo-two-feature',
      repoId: 'repo-2'
    })
  })

  it('returns no focused scan rows when the encoded repo id is unknown', async () => {
    const result = await scanWorkspaceCleanup(makeStore(), {
      worktreeId: 'missing-repo::/repo-feature'
    })

    expect(listRepoWorktreesMock).not.toHaveBeenCalled()
    expect(getStatusMock).not.toHaveBeenCalled()
    expect(result).toEqual({
      scannedAt: NOW,
      candidates: [],
      errors: []
    })
  })

  it('honors renderer git deferrals without hiding the workspace', async () => {
    const result = await scanWorkspaceCleanup(makeStore(), {
      skipGitWorktreeIds: ['repo-1::/repo-feature']
    })

    expect(getStatusMock).not.toHaveBeenCalled()
    expect(result.candidates[0]).toMatchObject({
      tier: 'review',
      selectedByDefault: false,
      reasons: ['idle-clean'],
      git: {
        clean: null,
        checkedAt: null
      }
    })
  })

  it('uses remote commit presence when a clean inactive workspace has no upstream', async () => {
    getStatusMock.mockResolvedValue({
      entries: [],
      conflictOperation: 'unknown',
      upstreamStatus: { hasUpstream: false, ahead: 0, behind: 0 }
    } satisfies GitStatusResult)

    const result = await scanWorkspaceCleanup(makeStore())

    expect(getStatusMock).toHaveBeenCalledTimes(1)
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      ['rev-list', '--count', 'HEAD', '--not', '--remotes'],
      { cwd: '/repo-feature', signal: expect.any(AbortSignal) }
    )
    expect(result.candidates[0]).toMatchObject({
      tier: 'ready',
      selectedByDefault: true,
      git: {
        clean: true,
        upstreamAhead: null
      }
    })
  })

  it('protects clean inactive workspaces with local-only commits', async () => {
    getStatusMock.mockResolvedValue({
      entries: [],
      conflictOperation: 'unknown',
      upstreamStatus: { hasUpstream: false, ahead: 0, behind: 0 }
    } satisfies GitStatusResult)
    gitExecFileAsyncMock.mockResolvedValue({ stdout: '2\n', stderr: '' })

    const result = await scanWorkspaceCleanup(makeStore())

    expect(result.candidates[0]).toMatchObject({
      tier: 'protected',
      selectedByDefault: false,
      blockers: ['unpushed-commits'],
      git: {
        clean: true,
        upstreamAhead: null
      }
    })
  })

  it('keeps diff notes as context instead of blocking inactive cleanup', async () => {
    const result = await scanWorkspaceCleanup(
      makeStore({
        baseRef: undefined,
        diffComments: [
          {
            id: 'comment-1',
            worktreeId: 'repo-1::/repo-feature',
            filePath: 'src/file.ts',
            lineNumber: 12,
            body: 'Follow up before deleting',
            createdAt: NOW - 1_000,
            side: 'modified'
          }
        ]
      })
    )

    expect(result.candidates[0]).toMatchObject({
      tier: 'ready',
      selectedByDefault: true,
      reasons: ['idle-clean'],
      localContext: {
        diffCommentCount: 1,
        newestDiffCommentAt: NOW - 1_000
      }
    })
  })

  it('summarizes large diff-note lists without hitting argument limits', async () => {
    const diffComments = Array.from(
      { length: 150_000 },
      (_, index): DiffComment => ({
        id: `comment-${index}`,
        worktreeId: 'repo-1::/repo-feature',
        filePath: 'src/file.ts',
        lineNumber: 12,
        body: 'Follow up before deleting',
        createdAt: NOW - index,
        side: 'modified'
      })
    )

    const result = await scanWorkspaceCleanup(
      makeStore({
        baseRef: undefined,
        diffComments
      })
    )

    expect(result.candidates[0]?.localContext).toMatchObject({
      diffCommentCount: 150_000,
      newestDiffCommentAt: NOW
    })
  })

  it('aggregates large cleanup candidate batches without hitting argument limits', async () => {
    listRepoWorktreesMock.mockResolvedValue(buildGitWorktrees(LARGE_WORKTREE_COUNT))

    const result = await scanWorkspaceCleanup(makeStore(), {
      skipGitWorktreeIds: buildWorktreeIds(REPO.id, LARGE_WORKTREE_COUNT)
    })

    expect(getStatusMock).not.toHaveBeenCalled()
    expect(result.errors).toEqual([])
    expect(result.candidates).toHaveLength(LARGE_WORKTREE_COUNT)
    expect(result.candidates[0]).toMatchObject({
      worktreeId: 'repo-1::/repo-feature-0',
      path: '/repo-feature-0',
      branch: 'feature-0',
      tier: 'review',
      git: {
        clean: null,
        checkedAt: null
      }
    })
    expect(result.candidates[LARGE_WORKTREE_COUNT - 1]).toMatchObject({
      worktreeId: `repo-1::/repo-feature-${LARGE_WORKTREE_COUNT - 1}`,
      path: `/repo-feature-${LARGE_WORKTREE_COUNT - 1}`,
      branch: `feature-${LARGE_WORKTREE_COUNT - 1}`
    })
  })

  it('does not expose PR cache state in inactivity cleanup results', async () => {
    const result = await scanWorkspaceCleanup(
      makeStore({
        repos: [REPO, { ...REPO, id: 'repo-2' }]
      })
    )

    expect(result.candidates[0]).toMatchObject({
      tier: 'ready',
      selectedByDefault: true,
      reasons: ['idle-clean']
    })
    expect(result.candidates[0]).not.toHaveProperty('linkedPR')
  })

  it('reports local processes that workspace deletion would kill', async () => {
    const localProvider = {
      listProcesses: vi.fn().mockResolvedValue([
        {
          id: 'repo-1::/repo-feature@@session-1',
          cwd: '/repo-feature',
          title: 'zsh'
        }
      ])
    }
    registerWorkspaceCleanupHandlers(makeStore(), {
      runtime: {
        hasTerminalsForWorktree: vi.fn().mockResolvedValue(false)
      } as never,
      getLocalPtyProvider: () => localProvider as never
    })

    const handler = vi
      .mocked(ipcMain.handle)
      .mock.calls.find(([channel]) => channel === 'workspaceCleanup:hasKillableLocalProcesses')?.[1]

    await expect(handler?.({} as never, { worktreeId: 'repo-1::/repo-feature' })).resolves.toEqual({
      hasKillableProcesses: true
    })
  })

  it('reports SSH processes inside the remote workspace path', async () => {
    getSshPtyProviderMock.mockReturnValue({
      listProcesses: vi.fn().mockResolvedValue([
        {
          id: 'remote-session-1',
          cwd: '/remote/repo-feature/subdir',
          title: 'codex'
        }
      ])
    })
    registerWorkspaceCleanupHandlers(makeStore(), {
      runtime: {
        hasTerminalsForWorktree: vi.fn().mockResolvedValue(false)
      } as never
    })

    const handler = vi
      .mocked(ipcMain.handle)
      .mock.calls.find(([channel]) => channel === 'workspaceCleanup:hasKillableLocalProcesses')?.[1]

    await expect(
      handler?.({} as never, {
        worktreeId: 'repo-ssh::/remote/repo-feature',
        connectionId: 'ssh-1',
        worktreePath: '/remote/repo-feature'
      })
    ).resolves.toEqual({
      hasKillableProcesses: true
    })
  })
})

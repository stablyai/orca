import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '../persistence'
import type { DiffComment, GitStatusResult, Repo } from '../../shared/types'

const { listRepoWorktreesMock, getStatusMock, gitExecFileAsyncMock, getSshGitProviderMock } =
  vi.hoisted(() => ({
    listRepoWorktreesMock: vi.fn(),
    getStatusMock: vi.fn(),
    gitExecFileAsyncMock: vi.fn(),
    getSshGitProviderMock: vi.fn()
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

import { scanWorkspaceCleanup } from './workspace-cleanup'

const NOW = 1_700_000_000_000
const REPO: Repo = {
  id: 'repo-1',
  path: '/repo',
  displayName: 'Repo',
  badgeColor: '#000',
  addedAt: NOW
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

  it('keeps raw scan errors out of renderer-facing results', async () => {
    listRepoWorktreesMock.mockRejectedValue(new Error('fatal: path /Users/alice/private failed'))

    const result = await scanWorkspaceCleanup(makeStore())

    expect(result.errors).toEqual([
      {
        repoId: 'repo-1',
        message: 'Could not scan workspace cleanup for this repository.'
      }
    ])
  })

  it('uses user-facing copy when remote workspaces are unavailable', async () => {
    const result = await scanWorkspaceCleanup(
      makeStore({
        repos: [{ ...REPO, connectionId: 'ssh-1' }]
      })
    )

    expect(result.errors).toEqual([
      {
        repoId: 'repo-1',
        message: 'Remote workspaces are not connected. Reconnect and refresh to check them.'
      }
    ])
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
      { cwd: '/repo-feature' }
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
})

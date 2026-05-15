import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '../persistence'
import type {
  DiffComment,
  GitBranchCompareResult,
  GitStatusResult,
  PRInfo,
  Repo
} from '../../shared/types'

const { listRepoWorktreesMock, getStatusMock, getBranchCompareMock, getSshGitProviderMock } =
  vi.hoisted(() => ({
    listRepoWorktreesMock: vi.fn(),
    getStatusMock: vi.fn(),
    getBranchCompareMock: vi.fn(),
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
  getStatus: getStatusMock,
  getBranchCompare: getBranchCompareMock
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
  prFetchedAt: number | null,
  options: {
    baseRef?: string
    diffComments?: DiffComment[]
    lastActivityAt?: number
    linkedIssue?: number | null
    linkedPR?: number | null
    prState?: PRInfo['state']
    repos?: Repo[]
  } = {}
): Store {
  const linkedPR = options.linkedPR === undefined ? 123 : options.linkedPR
  const baseRef = Object.hasOwn(options, 'baseRef') ? options.baseRef : 'origin/main'
  const pr =
    prFetchedAt === null
      ? {}
      : {
          '/repo::feature': {
            fetchedAt: prFetchedAt,
            data: {
              number: 123,
              title: 'Feature',
              state: options.prState ?? 'merged',
              url: 'https://github.example/pull/123',
              checksStatus: 'success',
              updatedAt: '2026-05-14T00:00:00Z',
              mergeable: 'MERGEABLE'
            } satisfies PRInfo
          }
        }
  return {
    getRepos: () => options.repos ?? [REPO],
    getWorktreeMeta: () => ({
      linkedPR,
      linkedIssue: options.linkedIssue ?? null,
      lastActivityAt: options.lastActivityAt ?? NOW - 40 * 24 * 60 * 60 * 1000,
      baseRef,
      diffComments: options.diffComments
    }),
    getAllWorktreeMeta: () => ({}),
    getGitHubCache: () => ({
      pr,
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
    getBranchCompareMock.mockReset()
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
    getBranchCompareMock.mockResolvedValue({
      summary: {
        baseRef: 'origin/main',
        baseOid: 'base',
        compareRef: 'feature',
        headOid: 'abc123',
        mergeBase: 'base',
        changedFiles: 0,
        status: 'ready'
      },
      entries: []
    } satisfies GitBranchCompareResult)
    getSshGitProviderMock.mockReturnValue(undefined)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not default-select from stale cached PR evidence', async () => {
    const staleFetchedAt = NOW - 5 * 60_000

    const result = await scanWorkspaceCleanup(makeStore(staleFetchedAt))

    expect(result.candidates[0]).toMatchObject({
      tier: 'review',
      selectedByDefault: false,
      staleEvidence: true,
      prStateCheckedAt: staleFetchedAt
    })
    expect(result.candidates[0].reasons).not.toContain('pr-merged')
    expect(getStatusMock).not.toHaveBeenCalled()
  })

  it('keeps raw scan errors out of renderer-facing results', async () => {
    listRepoWorktreesMock.mockRejectedValue(new Error('fatal: path /Users/alice/private failed'))

    const result = await scanWorkspaceCleanup(makeStore(NOW))

    expect(result.errors).toEqual([
      {
        repoId: 'repo-1',
        message: 'Could not scan workspace cleanup for this repository.'
      }
    ])
  })

  it('uses user-facing copy when remote workspaces are unavailable', async () => {
    const result = await scanWorkspaceCleanup(
      makeStore(NOW, {
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

  it('skips git status for workspaces with no cleanup signal', async () => {
    const result = await scanWorkspaceCleanup(
      makeStore(null, {
        linkedPR: null,
        lastActivityAt: NOW - 2 * 24 * 60 * 60 * 1000
      })
    )

    expect(getStatusMock).not.toHaveBeenCalled()
    expect(getBranchCompareMock).not.toHaveBeenCalled()
    expect(result.candidates[0]).toMatchObject({
      tier: 'review',
      selectedByDefault: false,
      git: {
        clean: null,
        checkedAt: null
      }
    })
  })

  it('honors renderer git deferrals without hiding the workspace', async () => {
    const result = await scanWorkspaceCleanup(makeStore(NOW), {
      skipGitWorktreeIds: ['repo-1::/repo-feature']
    })

    expect(getStatusMock).not.toHaveBeenCalled()
    expect(result.candidates[0]).toMatchObject({
      tier: 'review',
      selectedByDefault: false,
      reasons: ['pr-merged'],
      git: {
        clean: null,
        checkedAt: null
      }
    })
  })

  it('skips branch compare when upstream status already proves no unpushed commits', async () => {
    const result = await scanWorkspaceCleanup(makeStore(NOW))

    expect(getStatusMock).toHaveBeenCalledTimes(1)
    expect(getBranchCompareMock).not.toHaveBeenCalled()
    expect(result.candidates[0]).toMatchObject({
      tier: 'ready',
      selectedByDefault: true,
      git: {
        clean: true,
        upstreamAhead: 0,
        branchCompareChangedFiles: null
      }
    })
  })

  it('runs branch compare for trusted closed PRs before marking them clean', async () => {
    const result = await scanWorkspaceCleanup(makeStore(NOW, { prState: 'closed' }))

    expect(getStatusMock).toHaveBeenCalledTimes(1)
    expect(getBranchCompareMock).toHaveBeenCalledTimes(1)
    expect(result.candidates[0]).toMatchObject({
      tier: 'ready',
      selectedByDefault: true,
      reasons: ['pr-closed-clean', 'idle-clean'],
      git: {
        branchCompareChangedFiles: 0
      }
    })
  })

  it('does not default-select idle-only workspaces with local diff comments', async () => {
    const result = await scanWorkspaceCleanup(
      makeStore(null, {
        baseRef: undefined,
        linkedPR: null,
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
      tier: 'review',
      selectedByDefault: false,
      localContext: {
        diffCommentCount: 1,
        newestDiffCommentAt: NOW - 1_000
      }
    })
    expect(result.candidates[0].reasons).not.toContain('idle-clean')
  })

  it('does not use ambiguous PR cache state to make linked PR workspaces idle-ready', async () => {
    const result = await scanWorkspaceCleanup(
      makeStore(NOW, {
        repos: [REPO, { ...REPO, id: 'repo-2' }]
      })
    )

    expect(result.candidates[0]).toMatchObject({
      tier: 'review',
      selectedByDefault: false,
      linkedPR: { number: 123, state: 'merged' }
    })
    expect(result.candidates[0].reasons).not.toContain('pr-merged')
    expect(result.candidates[0].reasons).not.toContain('idle-clean')
  })
})

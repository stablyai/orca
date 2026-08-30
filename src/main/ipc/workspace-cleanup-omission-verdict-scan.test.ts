/**
 * What a scan's silence about one workspace is allowed to mean. The renderer
 * retires a confirmed row when the rescan stops listing it, so the scan has to
 * say whether it actually looked: a disconnected SSH host omits everything, and
 * `docs/reference/ssh-execution-boundary.md` forbids reading that as deletion.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '../persistence'
import type * as RepoWorktreesModule from '../repo-worktrees'
import type { GitStatusResult } from '../../shared/git-status-types'
import type { Repo } from '../../shared/repo-types'
import type { GitWorktreeInfo } from '../../shared/worktree/types'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'

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

vi.mock('node:fs/promises', () => ({ lstat: lstatMock, readFile: readFileMock }))
vi.mock('../repo-worktrees', async () => {
  const actual = await vi.importActual<typeof RepoWorktreesModule>('../repo-worktrees')
  return {
    listRepoWorktrees: listRepoWorktreesMock,
    createFolderWorktree: actual.createFolderWorktree
  }
})
vi.mock('../git/status', () => ({ getStatus: getStatusMock }))
vi.mock('../git/runner', () => ({ gitExecFileAsync: gitExecFileAsyncMock }))
vi.mock('../providers/ssh-git-dispatch', () => ({ getSshGitProvider: getSshGitProviderMock }))
vi.mock('../project-runtime-git-options', () => ({
  getLocalProjectWorktreeGitOptions: getLocalProjectWorktreeGitOptionsMock
}))

import { scanWorkspaceCleanup } from './workspace-cleanup-scan'

const NOW = 1_700_000_000_000
const DAY_MS = 24 * 60 * 60 * 1000
const LOCAL_REPO: Repo = {
  id: 'repo-1',
  path: '/repo',
  displayName: 'Repo',
  badgeColor: '#000',
  addedAt: NOW,
  symlinkPaths: []
}
const SSH_REPO: Repo = { ...LOCAL_REPO, connectionId: 'ssh-1', path: '/remote/repo' }
const TARGET_ID = 'repo-1::/repo-old'

const GIT_WORKTREES: GitWorktreeInfo[] = [
  { path: '/repo', head: 'main123', branch: 'refs/heads/main', isBare: false, isMainWorktree: true }
]

function makeWorktreeMeta(overrides: Partial<WorktreeMeta> = {}): WorktreeMeta {
  return {
    displayName: 'Old',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: NOW - 40 * DAY_MS,
    ...overrides
  } as WorktreeMeta
}

function makeStore(repos: Repo[], meta: Record<string, WorktreeMeta> = {}): Store {
  return {
    getRepos: () => repos,
    getWorktreeMeta: (worktreeId: string) => meta[worktreeId],
    getAllWorktreeMeta: () => meta,
    getGitHubCache: () => ({ pr: {}, issue: {} })
  } as unknown as Store
}

describe('what a workspace-cleanup scan says an omission means', () => {
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

  it('reads a disconnected SSH host with no persisted metadata as unverifiable', async () => {
    // The exact shape behind the bug: the synthesizer has no metadata to build a
    // row from, so the scan returns no candidate AND no error for this workspace.
    const result = await scanWorkspaceCleanup(makeStore([SSH_REPO]), {
      worktreeIds: [TARGET_ID],
      refreshActivity: true
    })

    expect(result.candidates).toEqual([])
    expect(result.errors).toEqual([])
    expect(result.repoListings).toEqual([
      { repoId: 'repo-1', executionHostId: 'ssh:ssh-1', verdict: 'unverifiable' }
    ])
  })

  it('still reads a disconnected SSH host as unverifiable when it can publish the row', async () => {
    // Honesty check: the omission verdict is about the listing, not about whether
    // one row happened to survive it.
    const result = await scanWorkspaceCleanup(
      makeStore([SSH_REPO], { [TARGET_ID]: makeWorktreeMeta() }),
      { worktreeIds: [TARGET_ID], refreshActivity: true }
    )

    expect(result.candidates.map((candidate) => candidate.worktreeId)).toEqual([TARGET_ID])
    expect(result.repoListings?.[0]?.verdict).toBe('unverifiable')
  })

  it('reads a completed targeted listing as exited', async () => {
    // The host answered and the workspace is not in its worktree list.
    const result = await scanWorkspaceCleanup(makeStore([LOCAL_REPO]), {
      worktreeIds: [TARGET_ID],
      refreshActivity: true
    })

    expect(result.candidates).toEqual([])
    expect(result.repoListings).toEqual([
      { repoId: 'repo-1', executionHostId: 'local', verdict: 'exited' }
    ])
  })

  it('reads a listing that failed as unverifiable', async () => {
    listRepoWorktreesMock.mockRejectedValue(new Error('git exploded'))

    const result = await scanWorkspaceCleanup(makeStore([LOCAL_REPO]), {
      worktreeIds: [TARGET_ID],
      refreshActivity: true
    })

    expect(result.repoListings?.[0]?.verdict).toBe('unverifiable')
  })

  it('reads a broad scan as unverifiable, because it omits active workspaces by design', async () => {
    const result = await scanWorkspaceCleanup(makeStore([LOCAL_REPO]))

    expect(result.repoListings?.[0]?.verdict).toBe('unverifiable')
  })
})

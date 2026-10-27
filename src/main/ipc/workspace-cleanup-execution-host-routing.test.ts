import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '../persistence'
import type { GitStatusResult } from '../../shared/git-status-types'
import type { Repo } from '../../shared/repo-types'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'

const {
  lstatMock,
  readFileMock,
  openMock,
  listRepoWorktreesMock,
  getStatusMock,
  gitExecFileAsyncMock,
  getLocalProjectWorktreeGitOptionsMock
} = vi.hoisted(() => ({
  lstatMock: vi.fn(),
  readFileMock: vi.fn(),
  openMock: vi.fn(),
  listRepoWorktreesMock: vi.fn(),
  getStatusMock: vi.fn(),
  gitExecFileAsyncMock: vi.fn(),
  getLocalProjectWorktreeGitOptionsMock: vi.fn()
}))

vi.mock('node:fs/promises', () => ({
  lstat: lstatMock,
  readFile: readFileMock,
  open: openMock
}))

vi.mock('../repo-worktrees', () => ({
  listRepoWorktrees: listRepoWorktreesMock,
  createFolderWorktree: vi.fn()
}))

vi.mock('../git/status', () => ({ getStatus: getStatusMock }))
vi.mock('../git/runner', () => ({ gitExecFileAsync: gitExecFileAsyncMock }))

vi.mock('../project-runtime-git-options', () => ({
  getLocalProjectWorktreeGitOptions: getLocalProjectWorktreeGitOptionsMock
}))

import { scanWorkspaceCleanup } from './workspace-cleanup-scan'

const NOW = 1_700_000_000_000
const INACTIVE_AT = NOW - 90 * 24 * 60 * 60 * 1000
const REPO_ID = 'repo-1'
const WORKTREE_PATH = '/remote/repo-feature'
const WORKTREE_ID = `${REPO_ID}::${WORKTREE_PATH}`

const CLEAN_STATUS: GitStatusResult = {
  entries: [],
  conflictOperation: 'unknown',
  upstreamStatus: { hasUpstream: true, ahead: 0, behind: 0 }
}

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: REPO_ID,
    path: '/remote/repo',
    displayName: 'Repo',
    badgeColor: '#000',
    addedAt: NOW,
    ...overrides
  }
}

function makeMeta(overrides: Partial<WorktreeMeta> = {}): WorktreeMeta {
  return {
    displayName: 'feature',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: INACTIVE_AT,
    ...overrides
  }
}

function makeStore(repos: Repo[], allMeta: Record<string, WorktreeMeta> = {}): Store {
  return {
    getRepos: () => repos,
    getWorktreeMeta: (worktreeId: string) => allMeta[worktreeId],
    getAllWorktreeMeta: () => allMeta,
    getGitHubCache: () => ({ pr: {}, issue: {} })
  } as unknown as Store
}

describe('workspace cleanup execution-host routing', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    lstatMock.mockReset().mockResolvedValue({ mtimeMs: 0 })
    readFileMock.mockReset().mockRejectedValue(new Error('not a gitdir pointer'))
    openMock.mockReset().mockRejectedValue(new Error('no reflog'))
    listRepoWorktreesMock.mockReset().mockResolvedValue([
      {
        path: WORKTREE_PATH,
        head: 'abc123',
        branch: 'refs/heads/feature',
        isBare: false,
        isMainWorktree: false
      }
    ])
    getStatusMock.mockReset().mockResolvedValue(CLEAN_STATUS)
    gitExecFileAsyncMock.mockReset().mockResolvedValue({ stdout: '0\n', stderr: '' })
    getLocalProjectWorktreeGitOptionsMock.mockReset().mockReturnValue({})
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('never lists or reads an executionHostId-only SSH repo on this machine', async () => {
    const store = makeStore([makeRepo({ executionHostId: 'ssh:alpha' })], {
      [WORKTREE_ID]: makeMeta()
    })

    await scanWorkspaceCleanup(store)

    expect(listRepoWorktreesMock).not.toHaveBeenCalled()
    expect(getStatusMock).not.toHaveBeenCalled()
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('never stats a remote workspace path on this client', async () => {
    const store = makeStore([makeRepo({ executionHostId: 'ssh:alpha' })], {
      [WORKTREE_ID]: makeMeta({ lastActivityAt: INACTIVE_AT })
    })

    await scanWorkspaceCleanup(store, { refreshActivity: true })

    expect(lstatMock).not.toHaveBeenCalled()
  })

  it('refuses a runtime host that carries no nested SSH target instead of scanning locally', async () => {
    const store = makeStore([makeRepo({ executionHostId: 'runtime:env-a' })], {
      [WORKTREE_ID]: makeMeta()
    })

    const result = await scanWorkspaceCleanup(store)

    expect(listRepoWorktreesMock).not.toHaveBeenCalled()
    expect(getStatusMock).not.toHaveBeenCalled()
    expect(result.candidates).toEqual([])
    expect(result.errors).toEqual([])
  })

  it('refuses a runtime host that names a nested SSH target', async () => {
    const store = makeStore(
      [makeRepo({ executionHostId: 'runtime:env-a', connectionId: 'alpha' })],
      { [WORKTREE_ID]: makeMeta() }
    )

    const result = await scanWorkspaceCleanup(store)

    // Nested runtime targets belong to the environment namespace, not this client's SSH registry.
    expect(listRepoWorktreesMock).not.toHaveBeenCalled()
    expect(result.candidates).toEqual([])
  })

  it('surfaces the runtime refusal as a scan error on a targeted scan', async () => {
    const store = makeStore(
      [makeRepo({ executionHostId: 'runtime:env-a', connectionId: 'alpha' })],
      { [WORKTREE_ID]: makeMeta() }
    )

    const result = await scanWorkspaceCleanup(store, { worktreeIds: [WORKTREE_ID] })

    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]?.executionHostId).toBe('runtime:env-a')
  })

  it('synthesizes disconnected rows for an executionHostId-only SSH host that is not connected', async () => {
    const store = makeStore([makeRepo({ executionHostId: 'ssh:alpha' })], {
      [WORKTREE_ID]: makeMeta({ hostId: 'ssh:alpha' })
    })

    const result = await scanWorkspaceCleanup(store, { includeAllWorkspaces: true })

    expect(listRepoWorktreesMock).not.toHaveBeenCalled()
    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0]?.blockers).toContain('ssh-disconnected')
    expect(result.candidates[0]?.executionHostId).toBe('ssh:alpha')
  })

  it('refuses git evidence when the workspace names a different host than the listing', async () => {
    // Metadata ownership can disagree with the listing; local reads must not be labeled as SSH evidence.
    const store = makeStore([makeRepo({ path: '/local/repo' })], {
      [`${REPO_ID}::${WORKTREE_PATH}`]: makeMeta({ hostId: 'ssh:alpha' })
    })

    const result = await scanWorkspaceCleanup(store)

    expect(listRepoWorktreesMock).toHaveBeenCalled()
    expect(getStatusMock).not.toHaveBeenCalled()
    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0]?.blockers).toContain('git-status-error')
    expect(result.candidates[0]?.executionHostId).toBe('ssh:alpha')
  })

  it('still routes a genuinely local repo to this machine', async () => {
    const store = makeStore([makeRepo({ path: '/local/repo' })], {
      [WORKTREE_ID]: makeMeta()
    })

    const result = await scanWorkspaceCleanup(store)

    expect(listRepoWorktreesMock).toHaveBeenCalled()
    expect(getStatusMock).toHaveBeenCalled()
    expect(result.candidates[0]?.executionHostId).toBe('local')
  })
})

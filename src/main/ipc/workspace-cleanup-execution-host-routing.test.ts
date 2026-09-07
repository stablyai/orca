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
  getSshGitProviderMock,
  getLocalProjectWorktreeGitOptionsMock
} = vi.hoisted(() => ({
  lstatMock: vi.fn(),
  readFileMock: vi.fn(),
  openMock: vi.fn(),
  listRepoWorktreesMock: vi.fn(),
  getStatusMock: vi.fn(),
  gitExecFileAsyncMock: vi.fn(),
  getSshGitProviderMock: vi.fn(),
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

vi.mock('../providers/ssh-git-dispatch', () => ({
  getSshGitProvider: getSshGitProviderMock,
  SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE: 'SSH git provider unavailable'
}))

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

/**
 * Two SSH targets are registered at once for every case: routing that answers with "some
 * connected host" instead of *this row's* host only shows up when a second one exists.
 */
const sshProviders = new Map<string, ReturnType<typeof makeSshGitProvider>>()

function makeSshGitProvider(): {
  listWorktrees: ReturnType<typeof vi.fn>
  getStatus: ReturnType<typeof vi.fn>
  exec: ReturnType<typeof vi.fn>
} {
  return {
    listWorktrees: vi.fn(async () => [
      {
        path: WORKTREE_PATH,
        head: 'abc123',
        branch: 'refs/heads/feature',
        isBare: false,
        isMainWorktree: false
      }
    ]),
    getStatus: vi.fn(async () => CLEAN_STATUS),
    exec: vi.fn(async () => ({ stdout: '0\n', stderr: '' }))
  }
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
    sshProviders.clear()
    sshProviders.set('alpha', makeSshGitProvider())
    sshProviders.set('beta', makeSshGitProvider())
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
    getSshGitProviderMock.mockReset().mockImplementation((id: string) => sshProviders.get(id))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('lists an executionHostId-only SSH repo through its own host, never locally', async () => {
    const store = makeStore([makeRepo({ executionHostId: 'ssh:alpha' })], {
      [WORKTREE_ID]: makeMeta()
    })

    const result = await scanWorkspaceCleanup(store)

    expect(sshProviders.get('alpha')?.listWorktrees).toHaveBeenCalledWith('/remote/repo', {
      signal: expect.any(AbortSignal)
    })
    expect(sshProviders.get('beta')?.listWorktrees).not.toHaveBeenCalled()
    expect(listRepoWorktreesMock).not.toHaveBeenCalled()
    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0]?.executionHostId).toBe('ssh:alpha')
  })

  it('reads git status and unpushed commits on the row-named host, not this machine', async () => {
    const store = makeStore([makeRepo({ executionHostId: 'ssh:alpha' })], {
      [WORKTREE_ID]: makeMeta()
    })
    getStatusMock.mockResolvedValue({
      ...CLEAN_STATUS,
      upstreamStatus: { hasUpstream: false }
    } as GitStatusResult)
    sshProviders.get('alpha')?.getStatus.mockResolvedValue({
      ...CLEAN_STATUS,
      upstreamStatus: { hasUpstream: false }
    })

    await scanWorkspaceCleanup(store)

    expect(sshProviders.get('alpha')?.getStatus).toHaveBeenCalledWith(WORKTREE_PATH, {
      includeLineStats: false,
      signal: expect.any(AbortSignal)
    })
    expect(sshProviders.get('alpha')?.exec).toHaveBeenCalled()
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

  it('keeps two simultaneously registered SSH hosts apart', async () => {
    const store = makeStore(
      [
        makeRepo({ id: 'repo-alpha', executionHostId: 'ssh:alpha' }),
        makeRepo({ id: 'repo-beta', connectionId: 'beta' })
      ],
      {
        [`repo-alpha::${WORKTREE_PATH}`]: makeMeta(),
        [`repo-beta::${WORKTREE_PATH}`]: makeMeta()
      }
    )

    await scanWorkspaceCleanup(store)

    expect(sshProviders.get('alpha')?.listWorktrees).toHaveBeenCalledTimes(1)
    expect(sshProviders.get('beta')?.listWorktrees).toHaveBeenCalledTimes(1)
    expect(sshProviders.get('alpha')?.getStatus).toHaveBeenCalledTimes(1)
    expect(sshProviders.get('beta')?.getStatus).toHaveBeenCalledTimes(1)
    expect(listRepoWorktreesMock).not.toHaveBeenCalled()
  })

  it('refuses a runtime host that carries no nested SSH target instead of scanning locally', async () => {
    const store = makeStore([makeRepo({ executionHostId: 'runtime:env-a' })], {
      [WORKTREE_ID]: makeMeta()
    })

    const result = await scanWorkspaceCleanup(store)

    expect(listRepoWorktreesMock).not.toHaveBeenCalled()
    expect(getStatusMock).not.toHaveBeenCalled()
    expect(result.candidates).toEqual([])
    // Broad scans omit hosts they cannot inspect rather than bannering them.
    expect(result.errors).toEqual([])
  })

  it('refuses a runtime host whose nested SSH target name is also registered on this client', async () => {
    const store = makeStore(
      [makeRepo({ executionHostId: 'runtime:env-a', connectionId: 'alpha' })],
      { [WORKTREE_ID]: makeMeta() }
    )

    const result = await scanWorkspaceCleanup(store)

    // 'alpha' names this client's own host; the runtime row's nested target lives in
    // env-a's namespace, so dialing it here would inspect an entirely different machine.
    expect(sshProviders.get('alpha')?.listWorktrees).not.toHaveBeenCalled()
    expect(sshProviders.get('alpha')?.getStatus).not.toHaveBeenCalled()
    expect(sshProviders.get('beta')?.listWorktrees).not.toHaveBeenCalled()
    expect(listRepoWorktreesMock).not.toHaveBeenCalled()
    expect(result.candidates).toEqual([])
  })

  it('surfaces the runtime refusal as a scan error on a targeted scan', async () => {
    const store = makeStore(
      [makeRepo({ executionHostId: 'runtime:env-a', connectionId: 'alpha' })],
      { [WORKTREE_ID]: makeMeta() }
    )

    const result = await scanWorkspaceCleanup(store, { worktreeIds: [WORKTREE_ID] })

    expect(sshProviders.get('alpha')?.listWorktrees).not.toHaveBeenCalled()
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]?.executionHostId).toBe('runtime:env-a')
  })

  it('synthesizes disconnected rows for an executionHostId-only SSH host that is not connected', async () => {
    sshProviders.delete('alpha')
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
    // One local row owns the id, but its persisted metadata claims an SSH host. Reading this
    // machine's checkout and labelling the row `ssh:alpha` is the cross-host leak.
    const store = makeStore([makeRepo({ path: '/local/repo' })], {
      [`${REPO_ID}::${WORKTREE_PATH}`]: makeMeta({ hostId: 'ssh:alpha' })
    })

    const result = await scanWorkspaceCleanup(store)

    expect(listRepoWorktreesMock).toHaveBeenCalled()
    expect(getStatusMock).not.toHaveBeenCalled()
    expect(sshProviders.get('alpha')?.getStatus).not.toHaveBeenCalled()
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
    expect(sshProviders.get('alpha')?.getStatus).not.toHaveBeenCalled()
    expect(result.candidates[0]?.executionHostId).toBe('local')
  })
})

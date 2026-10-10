import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '../persistence'
import type { Repo } from '../../shared/repo-types'
import type { GitWorktreeInfo, Worktree } from '../../shared/worktree/types'
import type * as CandidateModule from './workspace-cleanup-candidate'
import type * as GitRouteModule from './workspace-cleanup-git-route'

const {
  listRepoWorktreesMock,
  getLocalProjectWorktreeGitOptionsMock,
  getSshGitProviderMock,
  buildWorkspaceCleanupCandidateMock,
  resolveRepoGitRouteMock
} = vi.hoisted(() => ({
  listRepoWorktreesMock: vi.fn(),
  getLocalProjectWorktreeGitOptionsMock: vi.fn(),
  getSshGitProviderMock: vi.fn(),
  buildWorkspaceCleanupCandidateMock: vi.fn(),
  resolveRepoGitRouteMock: vi.fn()
}))

vi.mock('../repo-worktrees', () => ({
  createFolderWorktree: vi.fn(),
  listRepoWorktrees: listRepoWorktreesMock
}))

vi.mock('../project-runtime-git-options', () => ({
  getLocalProjectWorktreeGitOptions: getLocalProjectWorktreeGitOptionsMock
}))

vi.mock('../providers/ssh-git-dispatch', () => ({
  getSshGitProvider: getSshGitProviderMock
}))

vi.mock('./workspace-cleanup-activity', () => ({
  resolveWorkspaceCleanupActivityWorktree: (_repo: Repo, worktree: Worktree) => worktree,
  resolvePersistedWorkspaceCleanupActivityWorktree: (worktree: Worktree) => worktree
}))

// Why: the resolver runs once per repo the scan decided to look at, which is the
// only place a host-scoped selection is observable — a `runtime:` row is refused
// here, so it contributes neither worktrees nor an error to compare against.
vi.mock('./workspace-cleanup-git-route', async (importOriginal) => {
  const actual = await importOriginal<typeof GitRouteModule>()
  return { ...actual, resolveWorkspaceCleanupRepoGitRoute: resolveRepoGitRouteMock }
})

vi.mock('./workspace-cleanup-candidate', async (importOriginal) => {
  const actual = await importOriginal<typeof CandidateModule>()
  return { ...actual, buildWorkspaceCleanupCandidate: buildWorkspaceCleanupCandidateMock }
})

import { scanWorkspaceCleanup } from './workspace-cleanup-scan'

const NOW = Date.now()
const REPO: Repo = {
  id: 'repo-1',
  path: '/repo',
  displayName: 'Repo',
  badgeColor: '#000',
  addedAt: 0
}
const OTHER_REPO: Repo = { ...REPO, id: 'repo-2', path: '/other', displayName: 'Other' }
/** Same project id, different execution host — the collision host scoping exists for. */
const RUNTIME_NAMESAKE: Repo = { ...REPO, path: '/runtime-repo', executionHostId: 'runtime:env-1' }

const ACTIVE_WORKTREE: GitWorktreeInfo = {
  path: '/repo-feature',
  head: 'abc123',
  branch: 'refs/heads/feature',
  isBare: false,
  isMainWorktree: false
}
const MAIN_WORKTREE: GitWorktreeInfo = {
  path: '/repo',
  head: 'def456',
  branch: 'refs/heads/main',
  isBare: false,
  isMainWorktree: true
}

function buildStore(repos: Repo[]): Store {
  return {
    getRepos: () => repos,
    // Why: touched moments ago, so the idle window would exclude it.
    getWorktreeMeta: () => ({ lastActivityAt: NOW })
  } as unknown as Store
}

describe('project-scoped workspace cleanup scan', () => {
  beforeEach(() => {
    listRepoWorktreesMock.mockReset().mockResolvedValue([MAIN_WORKTREE, ACTIVE_WORKTREE])
    getLocalProjectWorktreeGitOptionsMock.mockReset().mockReturnValue({})
    getSshGitProviderMock.mockReset().mockReturnValue(undefined)
    resolveRepoGitRouteMock.mockReset().mockReturnValue({ kind: 'local', hostId: 'local' })
    buildWorkspaceCleanupCandidateMock
      .mockReset()
      .mockImplementation(async (args: { worktree: Worktree }) => ({
        worktreeId: args.worktree.id,
        blockers: [],
        reasons: []
      }))
  })

  it('scans a workspace the idle window would have skipped', async () => {
    const result = await scanWorkspaceCleanup(buildStore([REPO]), { repoId: 'repo-1' })

    expect(result.candidates.map((candidate) => candidate.worktreeId)).toContain(
      'repo-1::/repo-feature'
    )
  })

  it('leaves the all-projects scan gated on inactivity', async () => {
    const result = await scanWorkspaceCleanup(buildStore([REPO]), {})

    expect(result.candidates).toHaveLength(0)
    expect(buildWorkspaceCleanupCandidateMock).not.toHaveBeenCalled()
  })

  it('reads Git for every workspace it offers, since the merge proof needs it', async () => {
    await scanWorkspaceCleanup(buildStore([REPO]), { repoId: 'repo-1' })

    expect(buildWorkspaceCleanupCandidateMock).toHaveBeenCalledWith(
      expect.objectContaining({ forceGitCheck: true })
    )
  })

  it('lists the primary checkout the same way the full browser does', async () => {
    // Why: matching includeAllWorkspaces keeps one dialog behaving one way. The
    // row is inert either way — buildWorkspaceCleanupCandidate stamps the
    // main-worktree blocker, which bars it from queueing for removal.
    await scanWorkspaceCleanup(buildStore([REPO]), { repoId: 'repo-1' })

    const scannedPaths = buildWorkspaceCleanupCandidateMock.mock.calls.map(
      (call) => (call[0] as { worktree: Worktree }).worktree.path
    )
    expect(scannedPaths).toEqual(['/repo', '/repo-feature'])
  })

  it('leaves other projects alone', async () => {
    await scanWorkspaceCleanup(buildStore([REPO, OTHER_REPO]), { repoId: 'repo-1' })

    expect(listRepoWorktreesMock).toHaveBeenCalledTimes(1)
    expect(listRepoWorktreesMock).toHaveBeenCalledWith(REPO, expect.anything())
  })

  it('does not reach into another host that reuses the same project id', async () => {
    // Why: repo ids are unique per execution host, not globally. Matching the id
    // alone would consider a namesake on a host the user was not looking at.
    await scanWorkspaceCleanup(buildStore([REPO, RUNTIME_NAMESAKE]), {
      repoId: 'repo-1',
      executionHostId: 'local'
    })

    expect(resolveRepoGitRouteMock).toHaveBeenCalledTimes(1)
    expect(resolveRepoGitRouteMock).toHaveBeenCalledWith(REPO)
  })

  it('keeps the broader id-only match when no host is given', async () => {
    await scanWorkspaceCleanup(buildStore([REPO, RUNTIME_NAMESAKE]), { repoId: 'repo-1' })

    // Why: asserting both were considered is the point — checking only the local
    // one would still pass if a future change silently narrowed the id-only
    // scope, which is exactly the back-compatibility this pins.
    expect(resolveRepoGitRouteMock).toHaveBeenCalledTimes(2)
    expect(resolveRepoGitRouteMock).toHaveBeenCalledWith(REPO)
    expect(resolveRepoGitRouteMock).toHaveBeenCalledWith(RUNTIME_NAMESAKE)
  })

  it('passes the project Git routing down to the candidate build', async () => {
    getLocalProjectWorktreeGitOptionsMock.mockReturnValue({ wslDistro: 'Ubuntu' })

    await scanWorkspaceCleanup(buildStore([REPO]), { repoId: 'repo-1' })

    expect(buildWorkspaceCleanupCandidateMock).toHaveBeenCalledWith(
      expect.objectContaining({ localGitOptions: { wslDistro: 'Ubuntu' } })
    )
  })
})

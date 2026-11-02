import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  gitExecFileAsync: vi.fn(),
  getGiteaRepoRefForRemote: vi.fn(),
  getGiteaWorkItemDetails: vi.fn(),
  fetchGiteaPullRequestHeadRef: vi.fn(),
  fetchCompareBaseRefWithLocalFallback: vi.fn()
}))

vi.mock('../git/runner', () => ({ gitExecFileAsync: mocks.gitExecFileAsync }))
vi.mock('../git/repo', () => ({ getDefaultRemote: vi.fn().mockResolvedValue('origin') }))
vi.mock('../git/compare-base-ref-fetch', () => ({
  fetchCompareBaseRefWithLocalFallback: mocks.fetchCompareBaseRefWithLocalFallback
}))
vi.mock('../gitea/repository-ref', () => ({
  getGiteaRepoRefForRemote: mocks.getGiteaRepoRefForRemote
}))
vi.mock('../gitea/work-item-details', () => ({
  getGiteaWorkItemDetails: mocks.getGiteaWorkItemDetails
}))
vi.mock('../gitea/pr-head-tracking-ref', () => ({
  fetchGiteaPullRequestHeadRef: mocks.fetchGiteaPullRequestHeadRef
}))
vi.mock('../repo-execution-host', () => ({ requireRepoLocalGitRoute: vi.fn() }))
vi.mock('../project-runtime-git-options', () => ({
  getLocalProjectGitExecOptions: () => ({ cwd: '/repo' }),
  getLocalProjectWorktreeGitOptions: () => ({})
}))
vi.mock('../github/pr-start-point-wsl-gate', () => ({
  resolvePrStartPointUnlessWslStopped: (_target: unknown, _opts: unknown, run: () => unknown) =>
    run()
}))

import { resolveRuntimeGiteaWorktreeBase } from './runtime-gitea-worktree-base'

const repo = { id: 'r1', path: '/repo', kind: 'git' }
const deps = {
  // SAFETY: the resolver under test never reads the store.
  store: {} as never,
  resolveRepo: vi.fn().mockResolvedValue(repo)
}

describe('resolveRuntimeGiteaWorktreeBase', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((m) => m.mockReset())
    mocks.getGiteaRepoRefForRemote.mockImplementation(async (_p: string, remote: string) =>
      remote === 'origin' ? { host: 'g', owner: 'o', repo: 'r' } : null
    )
    mocks.gitExecFileAsync.mockResolvedValue({ stdout: 'abc123\n', stderr: '' })
    mocks.fetchCompareBaseRefWithLocalFallback.mockResolvedValue(true)
  })

  it('returns a remote branch and push target for a same-repo PR', async () => {
    await expect(
      resolveRuntimeGiteaWorktreeBase(
        { repoSelector: 'id:r1', prNumber: 5, headRefName: 'feat', baseRefName: 'main' },
        deps
      )
    ).resolves.toEqual({
      baseBranch: 'origin/feat',
      compareBaseRef: 'refs/remotes/origin/main',
      pushTarget: { remoteName: 'origin', branchName: 'feat' }
    })
  })

  it('fetches refs/pull/N/head for a fork PR and returns its SHA', async () => {
    mocks.fetchGiteaPullRequestHeadRef.mockResolvedValue('refs/orca/review-heads/x/pr-5')
    const result = await resolveRuntimeGiteaWorktreeBase(
      {
        repoSelector: 'id:r1',
        prNumber: 5,
        headRefName: 'feat',
        baseRefName: 'main',
        isCrossRepository: true
      },
      deps
    )
    expect(result).toEqual({ baseBranch: 'abc123', compareBaseRef: 'refs/remotes/origin/main' })
    expect(mocks.fetchGiteaPullRequestHeadRef).toHaveBeenCalledWith(repo, 'origin', 5, {
      localGitExecOptions: { cwd: '/repo' }
    })
  })

  it('reports gitea.forkHeadUnresolved when the fork head SHA is empty', async () => {
    mocks.fetchGiteaPullRequestHeadRef.mockResolvedValue('refs/orca/review-heads/x/pr-5')
    mocks.gitExecFileAsync.mockResolvedValue({ stdout: '\n', stderr: '' })
    const result = await resolveRuntimeGiteaWorktreeBase(
      { repoSelector: 'id:r1', prNumber: 5, headRefName: 'feat', isCrossRepository: true },
      deps
    )
    expect(result).toMatchObject({ errorCode: 'gitea.forkHeadUnresolved' })
  })

  it('reports gitea.prNotFound when details cannot be loaded', async () => {
    mocks.getGiteaWorkItemDetails.mockResolvedValue(null)
    const result = await resolveRuntimeGiteaWorktreeBase(
      { repoSelector: 'id:r1', prNumber: 9 },
      deps
    )
    expect(result).toMatchObject({ errorCode: 'gitea.prNotFound' })
  })
})

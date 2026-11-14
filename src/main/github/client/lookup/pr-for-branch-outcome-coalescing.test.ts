import type * as GithubRepositoryIdentityModule from '../../repositories/github-repository-identity'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PRRefreshOutcome } from '../../../../shared/github/pull-requests/refresh/pull-request-refresh-types'
import type {
  GitHubRepoContext,
  LocalGitExecOptions
} from '../../repositories/github-repository-identity'

import { __resetHostedReviewBranchCacheForTests } from '../../../source-control/hosted-review-branch-cache'

const mocks = vi.hoisted(() => ({ resolve: vi.fn(), acquire: vi.fn(), release: vi.fn() }))
vi.mock('../../execution/github-operation-slots', () => ({
  acquire: mocks.acquire,
  release: mocks.release
}))

vi.mock('../../repositories/github-repository-identity', async (importOriginal) => ({
  ...(await importOriginal<typeof GithubRepositoryIdentityModule>()),
  githubRepoContext: (
    repoPath: string,
    connectionId: string | null,
    options: LocalGitExecOptions
  ) => ({
    repoPath,
    connectionId,
    ...options
  }),
  ghRepoExecOptions: (context: GitHubRepoContext) => context
}))
vi.mock('./branch-lookup-resolution', () => ({
  resolvePRForBranchOutcome: mocks.resolve
}))
vi.mock('./pr-for-branch-outcome', async () => ({
  getPRForBranchOutcome: (await import('./pr-for-branch-outcome')).getPRForBranchOutcome
}))

vi.mock('../fetch/repo-slug-upstream', async () => ({
  getRepoSlug: vi.fn(async () => ({ owner: 'acme', repo: 'orca' }))
}))

vi.mock('./pr-lookup-rate-limit', async () => ({
  getGitHubPRLookupRateLimitBlock: vi.fn(async () => null)
}))

vi.mock('../create/create-github-pull-request', async () => ({
  createGitHubPullRequest: vi.fn()
}))
vi.mock('../../../gitlab/merge-requests/merge-request-lookup', () => ({
  getProjectSlug: vi.fn(async () => null)
}))
import { getPRForBranchOutcome } from './pr-for-branch-outcome'

const outcome: PRRefreshOutcome = { kind: 'no-pr', fetchedAt: 1 }
beforeEach(() => {
  vi.clearAllMocks()
  mocks.resolve.mockReset()
  __resetHostedReviewBranchCacheForTests()
  mocks.acquire.mockResolvedValue(undefined)
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

describe('PR lookup coalescing', () => {
  it('cleans up errors so later reads can recover', async () => {
    mocks.resolve.mockRejectedValueOnce(new Error('network down')).mockResolvedValue(outcome)
    const results = await Promise.all([
      getPRForBranchOutcome('/repo', 'topic'),
      getPRForBranchOutcome('/repo', 'topic')
    ])
    expect(results.every((result) => result.kind === 'upstream-error')).toBe(true)
    expect(mocks.resolve).toHaveBeenCalledTimes(1)
    await expect(getPRForBranchOutcome('/repo', 'topic')).resolves.toEqual(outcome)
    expect(mocks.resolve).toHaveBeenCalledTimes(2)
  })
})

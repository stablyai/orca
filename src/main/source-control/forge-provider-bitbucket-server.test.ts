import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  getBitbucketRepoSlugMock,
  getBitbucketPullRequestForBranchOrThrowMock,
  getBitbucketPullRequestMock,
  createBitbucketPullRequestMock,
  getBitbucketServerRepoRefMock,
  getBitbucketServerPullRequestForBranchOrThrowMock,
  getBitbucketServerPullRequestMock,
  createBitbucketServerPullRequestMock
} = vi.hoisted(() => ({
  getBitbucketRepoSlugMock: vi.fn(),
  getBitbucketPullRequestForBranchOrThrowMock: vi.fn(),
  getBitbucketPullRequestMock: vi.fn(),
  createBitbucketPullRequestMock: vi.fn(),
  getBitbucketServerRepoRefMock: vi.fn(),
  getBitbucketServerPullRequestForBranchOrThrowMock: vi.fn(),
  getBitbucketServerPullRequestMock: vi.fn(),
  createBitbucketServerPullRequestMock: vi.fn()
}))

vi.mock('../bitbucket/client', () => ({
  getBitbucketRepoSlug: getBitbucketRepoSlugMock,
  getBitbucketPullRequestForBranchOrThrow: getBitbucketPullRequestForBranchOrThrowMock,
  getBitbucketPullRequest: getBitbucketPullRequestMock
}))
vi.mock('../bitbucket/pull-request-creation', () => ({
  createBitbucketPullRequest: createBitbucketPullRequestMock
}))
vi.mock('../bitbucket/server-repository-ref', () => ({
  getBitbucketServerRepoRef: getBitbucketServerRepoRefMock
}))
vi.mock('../bitbucket/server-client', () => ({
  getBitbucketServerPullRequestForBranchOrThrow: getBitbucketServerPullRequestForBranchOrThrowMock,
  getBitbucketServerPullRequest: getBitbucketServerPullRequestMock
}))
vi.mock('../bitbucket/server-pull-request-creation', () => ({
  createBitbucketServerPullRequest: createBitbucketServerPullRequestMock
}))

import { getForgeProviderById } from './forge-provider'

const SERVER_REF = { baseUrl: 'https://bitbucket.example.com', projectKey: 'prj', repoSlug: 'repo' }
const CONTEXT = { repoPath: '/repo', executionHostId: 'local' } as const

function prInfo(overrides: Record<string, unknown> = {}) {
  return {
    number: 12,
    title: 'Add server support',
    state: 'open',
    url: 'https://bitbucket.example.com/projects/PRJ/repos/repo/pull-requests/12',
    status: 'success',
    updatedAt: '2026-10-18T00:00:00.000Z',
    mergeable: 'MERGEABLE',
    headSha: 'abc123',
    ...overrides
  }
}

describe('bitbucket forge provider with Bitbucket Server', () => {
  const provider = getForgeProviderById('bitbucket')

  beforeEach(() => {
    vi.clearAllMocks()
    getBitbucketServerRepoRefMock.mockResolvedValue(null)
    getBitbucketRepoSlugMock.mockResolvedValue(null)
  })

  it('resolves a server remote as bitbucket when the host is registered', async () => {
    getBitbucketServerRepoRefMock.mockResolvedValue(SERVER_REF)

    await expect(provider.resolveRepository(CONTEXT)).resolves.toEqual(SERVER_REF)
    expect(getBitbucketRepoSlugMock).not.toHaveBeenCalled()
  })

  it('keeps the cloud path when no server matches', async () => {
    getBitbucketRepoSlugMock.mockResolvedValue({ workspace: 'team', repoSlug: 'repo' })
    getBitbucketPullRequestForBranchOrThrowMock.mockResolvedValue(prInfo({ mergeable: 'UNKNOWN' }))

    await expect(provider.resolveRepository(CONTEXT)).resolves.toEqual({
      workspace: 'team',
      repoSlug: 'repo'
    })
    const review = await provider.getReviewForBranch({ ...CONTEXT, branch: 'feat' })
    expect(review).not.toHaveProperty('reviewDecision')
    expect(getBitbucketServerPullRequestForBranchOrThrowMock).not.toHaveBeenCalled()
  })

  it('routes branch, number and create calls to the server client for server repos', async () => {
    getBitbucketServerRepoRefMock.mockResolvedValue(SERVER_REF)
    getBitbucketServerPullRequestForBranchOrThrowMock.mockResolvedValue(
      prInfo({ reviewDecision: 'APPROVED' })
    )
    getBitbucketServerPullRequestMock.mockResolvedValue(prInfo({ number: 13 }))
    createBitbucketServerPullRequestMock.mockResolvedValue({ ok: true, number: 14, url: 'u' })

    await expect(
      provider.getReviewForBranch({ ...CONTEXT, branch: 'feat', linkedReviewNumber: 9 })
    ).resolves.toMatchObject({ provider: 'bitbucket', number: 12, reviewDecision: 'APPROVED' })
    await expect(provider.getReviewByNumber({ ...CONTEXT, number: 13 })).resolves.toMatchObject({
      number: 13
    })
    const input = { provider: 'bitbucket' as const, base: 'main', head: 'feat', title: 't' }
    await expect(provider.createReview?.('/repo', input, 'local')).resolves.toMatchObject({
      ok: true,
      number: 14
    })

    expect(getBitbucketServerPullRequestForBranchOrThrowMock).toHaveBeenCalledWith(
      '/repo',
      'feat',
      9,
      null
    )
    expect(getBitbucketPullRequestForBranchOrThrowMock).not.toHaveBeenCalled()
    expect(getBitbucketPullRequestMock).not.toHaveBeenCalled()
    expect(createBitbucketPullRequestMock).not.toHaveBeenCalled()
  })

  it('routes cloud and server repos separately when both are registered', async () => {
    getBitbucketServerRepoRefMock.mockImplementation(async (repoPath: string) =>
      repoPath === '/server-repo' ? SERVER_REF : null
    )
    getBitbucketServerPullRequestMock.mockResolvedValue(prInfo({ number: 1 }))
    getBitbucketPullRequestMock.mockResolvedValue(prInfo({ number: 2 }))

    await expect(
      provider.getReviewByNumber({ ...CONTEXT, repoPath: '/server-repo', number: 1 })
    ).resolves.toMatchObject({ number: 1 })
    await expect(
      provider.getReviewByNumber({ ...CONTEXT, repoPath: '/cloud-repo', number: 2 })
    ).resolves.toMatchObject({ number: 2 })
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'

// Defined inside vi.hoisted so the vi.mock factory (hoisted above imports) can
// reference the fake error class.
const { requestJsonMock, FakeHostedReviewApiRequestError } = vi.hoisted(() => {
  class FakeHostedReviewApiRequestError extends Error {
    status: number | null
    timedOut: boolean
    constructor(message: string, options: { status?: number | null; timedOut?: boolean } = {}) {
      super(message)
      this.status = options.status ?? null
      this.timedOut = options.timedOut ?? false
    }
  }
  return { requestJsonMock: vi.fn(), FakeHostedReviewApiRequestError }
})

vi.mock('../source-control/hosted-review-api-request', () => ({
  requestHostedReviewJson: requestJsonMock,
  HostedReviewApiRequestError: FakeHostedReviewApiRequestError
}))

vi.mock('../source-control/pull-request-template', () => ({
  readHostedPullRequestTemplate: vi.fn(async () => '')
}))

import { gitlabCompatFlavorClient } from './gitlab-compat-client'
import type { CustomGitServerRepoRef } from './api-flavor-client'

const ref: CustomGitServerRepoRef = {
  server: {
    id: 'srv',
    name: 'My Git Server',
    host: 'git.example.com',
    apiBaseUrl: 'https://git.example.com',
    apiFlavor: 'gitlab'
  },
  owner: 'team',
  repo: 'orca'
}

function rawMr(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iid: 7,
    title: 'My change',
    state: 'opened',
    web_url: 'https://git.example.com/team/orca/-/merge_requests/7',
    updated_at: '2026-01-01T00:00:00Z',
    sha: 'abc123',
    target_branch: 'main',
    head_pipeline: { status: 'success' },
    ...overrides
  }
}

describe('gitlabCompatFlavorClient', () => {
  beforeEach(() => {
    requestJsonMock.mockReset()
  })

  it('verify returns the account on success', async () => {
    requestJsonMock.mockResolvedValueOnce({ username: 'fanyunqian' })
    await expect(gitlabCompatFlavorClient.verify(ref.server, 'tok')).resolves.toEqual({
      account: 'fanyunqian'
    })
    // Hits the GitLab v4 /user endpoint with the token.
    const [url, init] = requestJsonMock.mock.calls[0]
    expect(String(url)).toBe('https://git.example.com/api/v4/user')
    expect((init.headers as Record<string, string>)['PRIVATE-TOKEN']).toBe('tok')
  })

  it('verify returns null when the request fails', async () => {
    requestJsonMock.mockRejectedValueOnce(new Error('401'))
    await expect(gitlabCompatFlavorClient.verify(ref.server, 'tok')).resolves.toBeNull()
  })

  it('maps a branch MR to a custom-provider HostedReviewInfo', async () => {
    // First call: list by source_branch. Second: single MR (full detail).
    requestJsonMock.mockResolvedValueOnce([rawMr()]).mockResolvedValueOnce(rawMr())
    const review = await gitlabCompatFlavorClient.getReviewForBranch(ref, 'tok', 'feature/x', null)
    expect(review).toMatchObject({
      provider: 'custom',
      number: 7,
      state: 'open',
      status: 'success',
      url: 'https://git.example.com/team/orca/-/merge_requests/7',
      headSha: 'abc123',
      baseRefName: 'main'
    })
  })

  it('returns null when no MR matches the branch and no linked number', async () => {
    requestJsonMock.mockResolvedValueOnce([])
    await expect(
      gitlabCompatFlavorClient.getReviewForBranch(ref, 'tok', 'feature/x', null)
    ).resolves.toBeNull()
  })

  it('creates a merge request and returns its number/url', async () => {
    requestJsonMock.mockResolvedValueOnce(rawMr({ iid: 8, web_url: 'https://git.example.com/mr/8' }))
    const result = await gitlabCompatFlavorClient.createReview(
      ref,
      'tok',
      { provider: 'custom', base: 'main', head: 'feature/x', title: 'New' },
      '/repo',
      null
    )
    expect(result).toEqual({ ok: true, number: 8, url: 'https://git.example.com/mr/8' })
  })

  it('classifies a 401 create failure as auth_required', async () => {
    requestJsonMock.mockRejectedValueOnce(
      new FakeHostedReviewApiRequestError('unauthorized', { status: 401 })
    )
    const result = await gitlabCompatFlavorClient.createReview(
      ref,
      'tok',
      { provider: 'custom', base: 'main', head: 'feature/x', title: 'New' },
      '/repo',
      null
    )
    expect(result).toMatchObject({ ok: false, code: 'auth_required' })
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  HostedReviewApiRequestError,
  requestHostedReviewJson
} from '../source-control/hosted-review-api-request'
import { resolveBitbucketAuthConfig } from './resolve-auth'
import { getBitbucketRepoRef } from './repository-ref'
import { declineBitbucketPullRequest, mergeBitbucketPullRequest } from './pull-request-merge'
import { invalidateHostedReviewBranchCache } from '../source-control/hosted-review-branch-cache'
import type { ExecutionHostId } from '../../shared/execution-host'

vi.mock('../source-control/hosted-review-api-request', () => ({
  HostedReviewApiRequestError: class HostedReviewApiRequestError extends Error {
    readonly status: number | null
    readonly timedOut: boolean
    constructor(message: string, options: { status?: number | null; timedOut?: boolean } = {}) {
      super(message)
      this.status = options.status ?? null
      this.timedOut = options.timedOut ?? false
    }
  },
  requestHostedReviewJson: vi.fn()
}))

vi.mock('./resolve-auth', () => ({
  resolveBitbucketAuthConfig: vi.fn()
}))

vi.mock('./repository-ref', () => ({
  getBitbucketRepoRef: vi.fn()
}))

vi.mock('../source-control/hosted-review-branch-cache', () => ({
  invalidateHostedReviewBranchCache: vi.fn()
}))

describe('mergeBitbucketPullRequest', () => {
  const mockRepo = {
    workspace: 'my-workspace',
    repoSlug: 'my-repo'
  }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(resolveBitbucketAuthConfig).mockReturnValue({
      baseUrl: 'https://api.bitbucket.org/2.0',
      accessToken: 'test-token',
      email: null,
      apiToken: null
    })
    vi.mocked(getBitbucketRepoRef).mockResolvedValue(mockRepo)
  })

  it('sends correct merge request with default method', async () => {
    vi.mocked(requestHostedReviewJson).mockResolvedValue({})

    const result = await mergeBitbucketPullRequest('/repo/path', 42)

    expect(result).toEqual({ ok: true })
    expect(requestHostedReviewJson).toHaveBeenCalledWith(
      new URL(
        'https://api.bitbucket.org/2.0/repositories/my-workspace/my-repo/pullrequests/42/merge'
      ),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          merge_strategy: 'merge_commit',
          close_source_branch: false
        })
      }),
      60_000
    )
  })

  it('allows closing source branch when explicitly requested', async () => {
    vi.mocked(requestHostedReviewJson).mockResolvedValue({})

    const result = await mergeBitbucketPullRequest('/repo/path', 42, 'merge_commit', true)

    expect(result).toEqual({ ok: true })
    expect(requestHostedReviewJson).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        body: JSON.stringify({
          merge_strategy: 'merge_commit',
          close_source_branch: true
        })
      }),
      expect.anything()
    )
  })

  it('supports fast_forward merge method', async () => {
    vi.mocked(requestHostedReviewJson).mockResolvedValue({})

    const result = await mergeBitbucketPullRequest('/repo/path', 42, 'fast_forward', false)

    expect(result).toEqual({ ok: true })
    expect(requestHostedReviewJson).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        body: JSON.stringify({
          merge_strategy: 'fast_forward',
          close_source_branch: false
        })
      }),
      expect.anything()
    )
  })

  it('provides descriptive error when fast-forward is not possible', async () => {
    vi.mocked(requestHostedReviewJson).mockRejectedValue(
      new HostedReviewApiRequestError('Pull request cannot be fast forwarded', { status: 400 })
    )

    const result = await mergeBitbucketPullRequest('/repo/path', 42, 'fast_forward')

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('Fast-forward merge not possible')
    }
  })

  it('returns auth error when credentials are not configured', async () => {
    vi.mocked(resolveBitbucketAuthConfig).mockReturnValue({
      baseUrl: 'https://api.bitbucket.org/2.0',
      accessToken: null,
      email: null,
      apiToken: null
    })

    const result = await mergeBitbucketPullRequest('/repo/path', 42)

    expect(result).toEqual({
      ok: false,
      error:
        'Merge failed: Bitbucket is not connected. Connect Bitbucket in Settings > Integrations.'
    })
  })

  it('rejects non-HTTPS Bitbucket API baseUrl for merge', async () => {
    vi.mocked(resolveBitbucketAuthConfig).mockReturnValue({
      baseUrl: 'http://insecure-bitbucket.org/2.0',
      accessToken: 'test-token',
      email: null,
      apiToken: null
    })

    const result = await mergeBitbucketPullRequest('/repo/path', 42)

    expect(result).toEqual({
      ok: false,
      error: 'Merge failed: Bitbucket API URL must use HTTPS.'
    })
    expect(requestHostedReviewJson).not.toHaveBeenCalled()
  })

  it('invalidates branch cache on successful merge', async () => {
    vi.mocked(requestHostedReviewJson).mockResolvedValue({})

    const result = await mergeBitbucketPullRequest(
      '/repo/path',
      42,
      'merge_commit',
      true,
      'ssh:my-host'
    )

    expect(result).toEqual({ ok: true })
    expect(getBitbucketRepoRef).toHaveBeenCalledWith('/repo/path', 'my-host', expect.anything())
    expect(invalidateHostedReviewBranchCache).toHaveBeenCalledWith('/repo/path', 'ssh:my-host')
  })

  it('parses structured JSON error message from Bitbucket API', async () => {
    vi.mocked(requestHostedReviewJson).mockRejectedValue(
      new Error(
        JSON.stringify({
          error: { message: 'Branch permission prevented merge', detail: 'Needs 2 approvals' }
        })
      )
    )

    const result = await mergeBitbucketPullRequest('/repo/path', 42)

    expect(result).toEqual({
      ok: false,
      error: 'Merge failed: Branch permission prevented merge: Needs 2 approvals'
    })
  })

  it('returns structured error when host cannot be dispatched', async () => {
    const result = await mergeBitbucketPullRequest(
      '/repo/path',
      42,
      'merge_commit',
      false,
      'runtime:remote-env' as ExecutionHostId
    )

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('Merge failed:')
    }
    expect(requestHostedReviewJson).not.toHaveBeenCalled()
  })
})

describe('declineBitbucketPullRequest', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(resolveBitbucketAuthConfig).mockReturnValue({
      baseUrl: 'https://api.bitbucket.org/2.0',
      accessToken: 'test-token',
      email: null,
      apiToken: null
    })
    vi.mocked(getBitbucketRepoRef).mockResolvedValue({
      workspace: 'ws',
      repoSlug: 'repo'
    })
  })

  it('calls decline endpoint successfully and invalidates branch cache', async () => {
    vi.mocked(requestHostedReviewJson).mockResolvedValue({})

    const result = await declineBitbucketPullRequest('/repo/path', 10, 'ssh:remote-server')

    expect(result).toEqual({ ok: true })
    expect(getBitbucketRepoRef).toHaveBeenCalledWith(
      '/repo/path',
      'remote-server',
      expect.anything()
    )
    expect(invalidateHostedReviewBranchCache).toHaveBeenCalledWith(
      '/repo/path',
      'ssh:remote-server'
    )
    expect(requestHostedReviewJson).toHaveBeenCalledWith(
      new URL('https://api.bitbucket.org/2.0/repositories/ws/repo/pullrequests/10/decline'),
      expect.objectContaining({ method: 'POST' }),
      60_000
    )
  })

  it('rejects non-HTTPS Bitbucket API baseUrl for decline', async () => {
    vi.mocked(resolveBitbucketAuthConfig).mockReturnValue({
      baseUrl: 'http://insecure-bitbucket.org/2.0',
      accessToken: 'test-token',
      email: null,
      apiToken: null
    })

    const result = await declineBitbucketPullRequest('/repo/path', 10)

    expect(result).toEqual({
      ok: false,
      error: 'Close failed: Bitbucket API URL must use HTTPS.'
    })
    expect(requestHostedReviewJson).not.toHaveBeenCalled()
  })

  it('returns structured error when host cannot be dispatched', async () => {
    const result = await declineBitbucketPullRequest(
      '/repo/path',
      10,
      'runtime:remote-env' as ExecutionHostId
    )

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('Close failed:')
    }
    expect(requestHostedReviewJson).not.toHaveBeenCalled()
  })
})

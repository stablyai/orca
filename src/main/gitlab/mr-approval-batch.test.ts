import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostedReviewInfo } from '../../shared/hosted-review'
import type * as GlUtils from './gl-utils'

const { glabExecFileAsyncMock, getProjectSlugMock, acquireMock, releaseMock } = vi.hoisted(() => ({
  glabExecFileAsyncMock: vi.fn(),
  getProjectSlugMock: vi.fn(),
  acquireMock: vi.fn(),
  releaseMock: vi.fn()
}))

vi.mock('./gl-utils', async () => {
  const actual = await vi.importActual<typeof GlUtils>('./gl-utils')
  return {
    ...actual,
    glabExecFileAsync: glabExecFileAsyncMock,
    acquire: acquireMock,
    release: releaseMock
  }
})
vi.mock('./merge-request-lookup', () => ({ getProjectSlug: getProjectSlugMock }))

import {
  MR_APPROVAL_REFRESH_INTERVAL_MS,
  __resetGitLabApprovalCacheForTests,
  refreshGitLabApprovals,
  withCachedGitLabApproval
} from './mr-approval-batch'

function review(number: number, overrides: Partial<HostedReviewInfo> = {}): HostedReviewInfo {
  return {
    provider: 'gitlab',
    number,
    title: `MR ${number}`,
    state: 'open',
    url: `https://git.internal/g/p/-/merge_requests/${number}`,
    status: 'success',
    updatedAt: '2026-10-30T00:00:00Z',
    mergeable: 'UNKNOWN',
    ...overrides
  }
}

const graphqlResponse = {
  stdout: JSON.stringify({
    data: {
      currentUser: { id: 'gid://gitlab/User/3' },
      project: {
        mergeRequests: {
          nodes: [
            {
              iid: '4',
              approvalsRequired: 2,
              approvalsLeft: 1,
              approvedBy: { nodes: [{ id: 'gid://gitlab/User/3' }] },
              userPermissions: { canApprove: false }
            },
            {
              iid: '9',
              approvalsRequired: null,
              approvalsLeft: null,
              approvedBy: { nodes: [] },
              userPermissions: { canApprove: true }
            }
          ]
        }
      }
    }
  })
}

const attach = (number: number) => withCachedGitLabApproval(review(number), '/repo', 'conn-1', {})

describe('withCachedGitLabApproval', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    __resetGitLabApprovalCacheForTests()
    glabExecFileAsyncMock.mockReset()
    acquireMock.mockReset().mockResolvedValue(undefined)
    releaseMock.mockReset()
    getProjectSlugMock.mockReset().mockResolvedValue({ host: 'git.internal', path: 'g/p' })
  })
  afterEach(() => vi.useRealTimers())

  it('reads every shown MR in one GraphQL call and attaches it on later lookups', async () => {
    glabExecFileAsyncMock.mockResolvedValue(graphqlResponse)

    expect(attach(4)).not.toHaveProperty('approval')
    expect(attach(9)).not.toHaveProperty('approval')
    await vi.waitFor(() => expect(releaseMock).toHaveBeenCalledOnce())

    expect(glabExecFileAsyncMock).toHaveBeenCalledOnce()
    expect(glabExecFileAsyncMock).toHaveBeenCalledWith(
      [
        'api',
        '--hostname',
        'git.internal',
        'graphql',
        '-f',
        'query=query { currentUser { id } project(fullPath: "g/p") { mergeRequests(iids: ["4","9"], first: 100) { nodes { iid approvalsRequired approvalsLeft approvedBy { nodes { id } } userPermissions { canApprove } } } } }'
      ],
      {}
    )
    expect(attach(4).approval).toEqual({
      approvalsRequired: 2,
      approvalsLeft: 1,
      approvedCount: 1,
      userCanApprove: false,
      userHasApproved: true
    })
    expect(attach(9).approval).toEqual({
      approvalsRequired: 0,
      approvalsLeft: 0,
      approvedCount: 0,
      userCanApprove: true,
      userHasApproved: false
    })
    expect(glabExecFileAsyncMock).toHaveBeenCalledOnce()

    await vi.advanceTimersByTimeAsync(MR_APPROVAL_REFRESH_INTERVAL_MS)
    attach(4)
    await vi.waitFor(() => expect(glabExecFileAsyncMock).toHaveBeenCalledTimes(2))
  })

  it('leaves non-open and non-GitLab reviews alone without a request', async () => {
    expect(withCachedGitLabApproval(review(4, { state: 'merged' }), '/repo', null, {})).toEqual(
      review(4, { state: 'merged' })
    )
    withCachedGitLabApproval(review(4, { provider: 'github' }), '/repo', null, {})
    await vi.advanceTimersByTimeAsync(0)
    expect(getProjectSlugMock).not.toHaveBeenCalled()
  })

  it('hides approval after a failed read but keeps returning the review', async () => {
    glabExecFileAsyncMock.mockResolvedValueOnce(graphqlResponse)
    attach(4)
    await vi.waitFor(() => expect(attach(4).approval).toBeDefined())

    glabExecFileAsyncMock.mockRejectedValueOnce(new Error('HTTP 502'))
    await refreshGitLabApprovals('/repo')

    expect(attach(4)).toEqual(review(4))
    expect(releaseMock).toHaveBeenCalledTimes(2)
  })

  it('re-reads immediately when an approval changes, ignoring the interval', async () => {
    glabExecFileAsyncMock.mockResolvedValue(graphqlResponse)
    attach(4)
    await vi.waitFor(() => expect(glabExecFileAsyncMock).toHaveBeenCalledOnce())

    await refreshGitLabApprovals('/repo')

    expect(glabExecFileAsyncMock).toHaveBeenCalledTimes(2)
  })
})

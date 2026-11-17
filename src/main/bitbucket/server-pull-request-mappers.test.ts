import { describe, expect, it } from 'vitest'
import {
  deriveBitbucketServerBuildStatus,
  deriveBitbucketServerMergeable,
  deriveBitbucketServerReviewDecision,
  mapBitbucketServerPullRequest,
  mapBitbucketServerState
} from './server-pull-request-mappers'

const UPDATED = 1792460776769

function serverPr() {
  return {
    id: 12,
    title: 'Add server support',
    state: 'OPEN',
    updatedDate: UPDATED,
    fromRef: { id: 'refs/heads/feat', displayId: 'feat', latestCommit: 'abc123' },
    toRef: { id: 'refs/heads/main', displayId: 'main', latestCommit: 'def456' },
    reviewers: [{ user: { name: 'bob' }, status: 'APPROVED' }],
    links: {
      self: [{ href: 'https://bitbucket.example.com/projects/PRJ/repos/repo/pull-requests/12' }]
    }
  }
}

describe('Bitbucket Server mappers', () => {
  it.each([
    ['OPEN', 'open'],
    ['MERGED', 'merged'],
    ['DECLINED', 'closed'],
    ['unknown', 'open'],
    [undefined, 'open']
  ] as const)('maps state %s to %s', (state, expected) => {
    expect(mapBitbucketServerState(state)).toBe(expected)
  })

  it.each([
    [{ successful: 1, inProgress: 1, failed: 1 }, 'failure'],
    [{ successful: 1, inProgress: 1, failed: 0 }, 'pending'],
    [{ successful: 2, inProgress: 0, failed: 0 }, 'success'],
    [{ successful: 0, inProgress: 0, failed: 0 }, 'neutral'],
    [null, 'neutral']
  ] as const)('derives build status from %o', (stats, expected) => {
    expect(deriveBitbucketServerBuildStatus(stats)).toBe(expected)
  })

  it.each([
    [{ canMerge: false, conflicted: true, outcome: 'CONFLICTED' }, 'CONFLICTING'],
    [{ canMerge: true, conflicted: false, outcome: 'CLEAN' }, 'MERGEABLE'],
    // Why: a veto such as missing approvals blocks merge without a conflict.
    [{ canMerge: false, conflicted: false, outcome: 'CLEAN' }, 'MERGEABLE'],
    [{ canMerge: false, conflicted: false }, 'UNKNOWN'],
    [null, 'UNKNOWN']
  ] as const)('derives mergeable from %o', (merge, expected) => {
    expect(deriveBitbucketServerMergeable(merge)).toBe(expected)
  })

  it.each([
    [[{ status: 'APPROVED' }, { status: 'NEEDS_WORK' }], 'CHANGES_REQUESTED'],
    [[{ status: 'APPROVED' }, { status: 'UNAPPROVED' }], 'APPROVED'],
    [[{ status: 'UNAPPROVED' }], 'REVIEW_REQUIRED'],
    [[], null],
    [undefined, null]
  ] as const)('derives review decision from %o', (reviewers, expected) => {
    expect(deriveBitbucketServerReviewDecision(reviewers)).toBe(expected)
  })

  it('maps a pull request with status, mergeable and review decision', () => {
    expect(mapBitbucketServerPullRequest(serverPr(), 'success', 'MERGEABLE')).toEqual({
      number: 12,
      title: 'Add server support',
      state: 'open',
      url: 'https://bitbucket.example.com/projects/PRJ/repos/repo/pull-requests/12',
      status: 'success',
      updatedAt: new Date(UPDATED).toISOString(),
      mergeable: 'MERGEABLE',
      reviewDecision: 'APPROVED',
      headSha: 'abc123'
    })
  })

  it.each([
    ['id', { id: undefined }],
    ['title', { title: '' }],
    ['url', { links: { self: [] } }]
  ])('returns null without %s', (_field, override) => {
    expect(
      mapBitbucketServerPullRequest({ ...serverPr(), ...override }, 'neutral', 'UNKNOWN')
    ).toBeNull()
  })

  it('leaves updatedAt empty when the server omits it', () => {
    expect(
      mapBitbucketServerPullRequest({ ...serverPr(), updatedDate: undefined }, 'neutral', 'UNKNOWN')
        ?.updatedAt
    ).toBe('')
  })

  it('tolerates non-string fields from a misbehaving proxy', () => {
    // JSON.parse yields an untyped payload, standing in for a malformed server response.
    const odd = JSON.parse(
      JSON.stringify({
        ...serverPr(),
        state: 1,
        fromRef: { latestCommit: 5 },
        reviewers: [{ status: 7 }]
      })
    )
    expect(() => mapBitbucketServerPullRequest(odd, 'neutral', 'UNKNOWN')).not.toThrow()
    expect(deriveBitbucketServerMergeable(JSON.parse('{"outcome":3}'))).toBe('UNKNOWN')
  })
})

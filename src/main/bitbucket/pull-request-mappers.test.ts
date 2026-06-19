import { describe, expect, it } from 'vitest'
import {
  deriveBitbucketBuildStatus,
  mapBitbucketPullRequest,
  mapBitbucketPullRequestState
} from './pull-request-mappers'

describe('Bitbucket pull request mappers', () => {
  it('normalizes Bitbucket pull request states', () => {
    expect(mapBitbucketPullRequestState('OPEN')).toBe('open')
    expect(mapBitbucketPullRequestState('MERGED')).toBe('merged')
    expect(mapBitbucketPullRequestState('DECLINED')).toBe('closed')
    expect(mapBitbucketPullRequestState('SUPERSEDED')).toBe('closed')
  })

  it('derives Orca check status from Bitbucket build statuses', () => {
    expect(deriveBitbucketBuildStatus([])).toBe('neutral')
    expect(deriveBitbucketBuildStatus([{ state: 'SUCCESSFUL' }])).toBe('success')
    expect(deriveBitbucketBuildStatus([{ state: 'INPROGRESS' }])).toBe('pending')
    expect(deriveBitbucketBuildStatus([{ state: 'FAILED' }])).toBe('failure')
  })

  it('maps raw pull request JSON into the shared PR-like shape', () => {
    expect(
      mapBitbucketPullRequest(
        {
          id: 42,
          title: 'Add Bitbucket',
          state: 'MERGED',
          updated_on: '2026-05-10T00:00:00.000Z',
          links: { html: { href: 'https://bitbucket.org/team/repo/pull-requests/42' } },
          source: { branch: { name: 'feature' }, commit: { hash: 'abc123' } },
          destination: { branch: { name: 'main' } }
        },
        'success'
      )
    ).toEqual({
      number: 42,
      title: 'Add Bitbucket',
      state: 'merged',
      url: 'https://bitbucket.org/team/repo/pull-requests/42',
      status: 'success',
      updatedAt: '2026-05-10T00:00:00.000Z',
      mergeable: 'UNKNOWN',
      headSha: 'abc123'
    })
  })
})

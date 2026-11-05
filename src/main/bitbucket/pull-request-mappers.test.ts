import { describe, expect, it } from 'vitest'
import { deriveBitbucketBuildStatus, mapBitbucketPullRequestState } from './pull-request-mappers'

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
})

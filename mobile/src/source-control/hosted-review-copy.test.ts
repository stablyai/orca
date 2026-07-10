import { describe, expect, it } from 'vitest'
import { hostedReviewCopy } from './hosted-review-copy'

describe('hostedReviewCopy', () => {
  it('uses Merge Request labels for GitLab', () => {
    expect(hostedReviewCopy('gitlab')).toEqual({
      shortLabel: 'MR',
      reviewLabel: 'merge request',
      titleLabel: 'Merge Request'
    })
  })

  it('uses Pull Request labels for GitHub and other providers and undefined', () => {
    const pr = { shortLabel: 'PR', reviewLabel: 'pull request', titleLabel: 'Pull Request' }
    expect(hostedReviewCopy('github')).toEqual(pr)
    expect(hostedReviewCopy('bitbucket')).toEqual(pr)
    expect(hostedReviewCopy(undefined)).toEqual(pr)
  })
})

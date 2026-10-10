import { describe, expect, it } from 'vitest'
import type { MRInfo } from '../../shared/gitlab-types'
import { mapGitLabReview } from './forge-review-mappers'

const mr: MRInfo = {
  number: 3,
  title: 't',
  state: 'opened',
  url: 'https://gitlab.com/g/p/-/merge_requests/3',
  pipelineStatus: 'success',
  updatedAt: '2026-10-04T00:00:00Z',
  mergeable: 'UNKNOWN',
  mergeStateStatus: 'not_approved'
}

describe('mapGitLabReview', () => {
  it('carries approval through to the hosted review', () => {
    const approval = {
      approvalsRequired: 2,
      approvalsLeft: 1,
      approvedCount: 1,
      userCanApprove: false,
      userHasApproved: true
    }
    expect(mapGitLabReview({ ...mr, approval }).approval).toEqual(approval)
  })

  it('omits approval when the lookup had none', () => {
    expect(mapGitLabReview(mr)).not.toHaveProperty('approval')
  })
})

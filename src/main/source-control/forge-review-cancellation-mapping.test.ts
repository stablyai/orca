import { describe, expect, it } from 'vitest'
import { mapAzureDevOpsReview, mapBitbucketReview, mapGitLabReview } from './forge-review-mappers'

describe('forge review cancellation mapping', () => {
  it('preserves GitLab cancellation as optional presentation metadata', () => {
    expect(
      mapGitLabReview({
        number: 1,
        title: 'MR',
        state: 'opened',
        url: 'https://gitlab.example/mr/1',
        pipelineStatus: 'failure',
        pipelinePresentationStatus: 'cancelled',
        updatedAt: '2026-01-01T00:00:00Z',
        mergeable: 'UNKNOWN'
      })
    ).toMatchObject({ status: 'failure', checkPresentationStatus: 'cancelled' })
  })

  it('preserves Bitbucket cancellation as optional presentation metadata', () => {
    expect(
      mapBitbucketReview({
        number: 2,
        title: 'PR',
        state: 'open',
        url: 'https://bitbucket.example/pr/2',
        status: 'failure',
        checkPresentationStatus: 'cancelled',
        updatedAt: '2026-01-01T00:00:00Z',
        mergeable: 'UNKNOWN'
      })
    ).toMatchObject({ status: 'failure', checkPresentationStatus: 'cancelled' })
  })

  it('preserves Azure DevOps cancellation as optional presentation metadata', () => {
    expect(
      mapAzureDevOpsReview({
        number: 3,
        title: 'PR',
        state: 'open',
        url: 'https://dev.azure.example/pr/3',
        status: 'failure',
        checkPresentationStatus: 'cancelled',
        updatedAt: '2026-01-01T00:00:00Z',
        mergeable: 'UNKNOWN'
      })
    ).toMatchObject({ status: 'failure', checkPresentationStatus: 'cancelled' })
  })
})

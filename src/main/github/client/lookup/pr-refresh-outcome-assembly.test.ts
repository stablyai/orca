import { describe, expect, it } from 'vitest'
import { assemblePRRefreshFoundOutcome } from './pr-refresh-outcome-assembly'

describe('assemblePRRefreshFoundOutcome review requests', () => {
  it('counts requests GitHub does not name instead of reporting none', () => {
    const outcome = assemblePRRefreshFoundOutcome({
      data: {
        number: 42,
        title: 'Keep reviewers honest',
        state: 'OPEN',
        url: 'https://github.com/acme/widgets/pull/42',
        statusCheckRollup: [],
        updatedAt: '2026-11-16T00:00:00Z',
        mergeable: 'MERGEABLE',
        reviewRequests: [
          { requestedReviewer: { __typename: 'Team', slug: 'acme/owners', name: 'Owners' } },
          { requestedReviewer: null }
        ],
        reviewRequestCount: 30,
        latestReviews: []
      },
      dataRepo: null,
      dataHeadRepo: null,
      stack: undefined,
      mergeable: 'MERGEABLE',
      stackMergeQueueRequired: undefined,
      confirmedContainedHeadOid: null,
      headDivergedFromMergedPRAtOid: null,
      conflictSummary: undefined
    })
    expect(outcome.kind === 'found' ? outcome.pr : null).toMatchObject({
      reviewRequests: [],
      teamReviewRequests: [{ slug: 'acme/owners', name: 'Owners' }],
      unnamedReviewRequestCount: 29
    })
  })
})

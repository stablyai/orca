import { describe, expect, it } from 'vitest'
import { assemblePRRefreshFoundOutcome } from './pr-refresh-outcome-assembly'
import type { PullRequestLookupData } from './pull-request-lookup-data'

describe('assemblePRRefreshFoundOutcome', () => {
  it('publishes action-required presentation without changing the legacy failure status', () => {
    const data = {
      number: 42,
      title: 'Approve workflows',
      state: 'OPEN',
      url: 'https://github.com/acme/orca/pull/42',
      statusCheckRollup: [{ state: 'ACTION_REQUIRED' }],
      updatedAt: '2026-08-26T00:00:00.000Z',
      mergeable: 'UNKNOWN',
      headRefOid: 'abc123'
    } satisfies PullRequestLookupData

    const outcome = assemblePRRefreshFoundOutcome({
      data,
      dataRepo: null,
      dataHeadRepo: null,
      stack: undefined,
      mergeable: 'UNKNOWN',
      stackMergeQueueRequired: undefined,
      confirmedContainedHeadOid: null,
      headDivergedFromMergedPRAtOid: null,
      conflictSummary: undefined
    })

    expect(outcome).toMatchObject({
      kind: 'found',
      pr: {
        checksStatus: 'failure',
        checksPresentationStatus: 'action_required'
      }
    })
  })
})

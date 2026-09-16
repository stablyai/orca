import { describe, expect, it } from 'vitest'
import {
  deriveAzureDevOpsStatus,
  deriveAzureDevOpsStatuses,
  mapAzureDevOpsPullRequest,
  mapAzureDevOpsPullRequestState
} from './pull-request-mappers'

describe('Azure DevOps pull request mappers', () => {
  it('maps Azure DevOps PR states into the hosted review state set', () => {
    expect(mapAzureDevOpsPullRequestState({ status: 'active' })).toBe('open')
    expect(mapAzureDevOpsPullRequestState({ status: 'active', isDraft: true })).toBe('draft')
    expect(mapAzureDevOpsPullRequestState({ status: 'completed' })).toBe('merged')
    expect(mapAzureDevOpsPullRequestState({ status: 'abandoned' })).toBe('closed')
  })

  it('derives check status from Azure DevOps PR and commit status states', () => {
    expect(deriveAzureDevOpsStatus([{ state: 'succeeded' }])).toBe('success')
    expect(deriveAzureDevOpsStatus([{ state: 'succeeded' }, { state: 'pending' }])).toBe('pending')
    expect(deriveAzureDevOpsStatus([{ state: 'succeeded' }, { state: 'failed' }])).toBe('failure')
    expect(deriveAzureDevOpsStatus([{ state: 'succeeded' }, { state: 'unknown' }])).toBe('neutral')
    expect(deriveAzureDevOpsStatus([])).toBe('neutral')
    expect(deriveAzureDevOpsStatuses([{ state: 'canceled' }])).toEqual({
      status: 'failure',
      presentationStatus: 'cancelled'
    })
    expect(deriveAzureDevOpsStatuses([{ state: 'canceled' }, { state: 'failed' }])).toEqual({
      status: 'failure'
    })
  })

  it('maps a raw PR into hosted review info', () => {
    expect(
      mapAzureDevOpsPullRequest(
        {
          pullRequestId: 42,
          title: 'Add Azure support',
          status: 'active',
          creationDate: '2026-05-15T12:00:00Z',
          mergeStatus: 'succeeded',
          lastMergeSourceCommit: { commitId: 'abc123' }
        },
        'success',
        'https://dev.azure.com/acme/Project/_git/repo'
      )
    ).toEqual({
      number: 42,
      title: 'Add Azure support',
      state: 'open',
      url: 'https://dev.azure.com/acme/Project/_git/repo/pullrequest/42',
      status: 'success',
      updatedAt: '2026-05-15T12:00:00Z',
      mergeable: 'MERGEABLE',
      headSha: 'abc123'
    })
  })
})

import { describe, expect, it } from 'vitest'
import { deriveAzureDevOpsStatus, mapAzureDevOpsPullRequestState } from './pull-request-mappers'

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
    expect(deriveAzureDevOpsStatus([])).toBe('neutral')
  })
})

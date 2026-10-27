import { describe, expect, it } from 'vitest'
import { normalizeLinkedPullRequests } from './project-view/project-view-field-normalization'
describe('normalizeLinkedPullRequests linked PR values', () => {
  it('normalizes linked pull requests with a visible overflow count', () => {
    const value = normalizeLinkedPullRequests({
      __typename: 'ProjectV2ItemFieldPullRequestValue',
      field: { id: 'field-pr', name: 'Linked pull requests', dataType: 'LINKED_PULL_REQUESTS' },
      pullRequests: {
        totalCount: 12,
        nodes: [{ number: 12, title: 'Fix', url: 'https://github.com/o/r/pull/12' }, null]
      }
    })
    expect(value).toEqual({
      pullRequests: [{ number: 12, title: 'Fix', url: 'https://github.com/o/r/pull/12' }],
      totalCount: 12
    })
  })
})

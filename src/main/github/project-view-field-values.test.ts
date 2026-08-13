import { describe, expect, it } from 'vitest'
import { normalizeFieldValue } from './project-view'

describe('normalizeFieldValue linked PR field values', () => {
  it('normalizes ProjectV2ItemFieldPullRequestValue with truncation metadata', () => {
    const value = normalizeFieldValue({
      __typename: 'ProjectV2ItemFieldPullRequestValue',
      field: { id: 'field-pr', name: 'Linked pull requests', dataType: 'LINKED_PULL_REQUESTS' },
      pullRequests: {
        totalCount: 12,
        pageInfo: { hasNextPage: true },
        nodes: [{ number: 12, title: 'Fix', url: 'https://github.com/o/r/pull/12' }, null]
      }
    })
    expect(value).toEqual({
      kind: 'pull-requests',
      fieldId: 'field-pr',
      pullRequests: [{ number: 12, title: 'Fix', url: 'https://github.com/o/r/pull/12' }],
      truncated: true,
      totalCount: 12
    })
  })

  it('marks non-truncated when total fits the page', () => {
    const value = normalizeFieldValue({
      __typename: 'ProjectV2ItemFieldPullRequestValue',
      field: { id: 'field-pr', name: 'Linked pull requests', dataType: 'LINKED_PULL_REQUESTS' },
      pullRequests: {
        totalCount: 1,
        pageInfo: { hasNextPage: false },
        nodes: [{ number: 7, title: 'Only', url: 'https://github.com/o/r/pull/7' }]
      }
    })
    expect(value).toMatchObject({ truncated: false, totalCount: 1 })
  })
})

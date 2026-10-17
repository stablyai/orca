import { describe, expect, it } from 'vitest'
import { normalizeFieldValue } from './project-view/project-view-field-normalization'
import { normalizeItem } from './project-view/project-view-item-normalization'
import {
  fieldValuesSelection,
  itemContentSelection,
  supportsProjectExtendedFields
} from './project-view/project-view-query-fragments'

describe('normalizeFieldValue linked PR values', () => {
  it('normalizes linked pull requests with a visible overflow count', () => {
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

  it('keeps the server count when all linked pull requests fit the page', () => {
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

  it('drops a typename that is not in GitHub’s field-value union', () => {
    expect(
      normalizeFieldValue({
        __typename: 'ProjectV2ItemFieldProgressValue',
        field: { id: 'field-sub', name: 'Sub-issues progress', dataType: 'SUB_ISSUES_PROGRESS' }
      })
    ).toBeNull()
  })
})

describe('sub-issues progress in project item content', () => {
  it('normalizes Issue.subIssuesSummary for the renderer', () => {
    const result = normalizeItem(
      {
        id: 'item-1',
        type: 'ISSUE',
        content: {
          __typename: 'Issue',
          id: 'issue-1',
          number: 42,
          title: 'Parent issue',
          subIssuesSummary: { completed: 1, total: 2, percentCompleted: 50 }
        }
      },
      0
    )
    expect(result).toMatchObject({
      ok: true,
      row: { content: { subIssuesProgress: { completed: 1, total: 2, percentCompleted: 50 } } }
    })
  })
})

describe('project extended GraphQL selections', () => {
  it('requests linked PR values and issue summaries only on supported hosts', () => {
    expect(fieldValuesSelection(true)).toContain('... on ProjectV2ItemFieldPullRequestValue')
    expect(fieldValuesSelection(false)).not.toContain('ProjectV2ItemFieldPullRequestValue')
    expect(itemContentSelection(true, true)).toContain(
      'subIssuesSummary { completed total percentCompleted }'
    )
    expect(itemContentSelection(true, false)).not.toContain('subIssuesSummary')
    expect(supportsProjectExtendedFields(undefined)).toBe(true)
    expect(supportsProjectExtendedFields('github.com')).toBe(true)
    expect(supportsProjectExtendedFields('github.example.com')).toBe(false)
  })
})

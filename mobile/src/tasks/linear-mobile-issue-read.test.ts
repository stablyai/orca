import { describe, expect, it } from 'vitest'
import { extractLinearIssueReadItems, type LinearMobileIssue } from './linear-mobile-issue-read'

function issue(id: string): LinearMobileIssue {
  return {
    id,
    identifier: `ENG-${id}`,
    title: `Issue ${id}`,
    url: `https://linear.app/acme/issue/ENG-${id}`,
    state: { name: 'Todo', type: 'unstarted', color: '#999999' },
    team: { id: 'team-1', name: 'Engineering', key: 'ENG' },
    labels: [],
    priority: 0,
    updatedAt: '2026-06-03T12:00:00.000Z'
  }
}

describe('extractLinearIssueReadItems', () => {
  it('keeps searchIssues array results unchanged', () => {
    const issues = [issue('1'), issue('2')]

    expect(extractLinearIssueReadItems(issues)).toBe(issues)
  })

  it('unwraps listIssues collection results', () => {
    const issues = [issue('1')]

    expect(extractLinearIssueReadItems({ items: issues, hasMore: true })).toBe(issues)
  })

  it('throws a clear error for unsupported payloads', () => {
    expect(() => extractLinearIssueReadItems({ hasMore: false })).toThrow(
      'Unexpected Linear tasks response'
    )
  })
})

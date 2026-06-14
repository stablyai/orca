import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LinearIssueContextResult, LinearSearchResult } from '../shared/linear-agent-access'
import { formatLinearIssue, printLinearSearchWarnings } from './linear-format'

describe('linear-format', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('treats older search results without workspaceErrors as non-partial', () => {
    const result = {
      issues: [],
      meta: {
        query: 'auth',
        workspaceId: 'all',
        limit: 20,
        returned: 0,
        limitReached: false,
        partial: false
      }
    } as unknown as LinearSearchResult

    printLinearSearchWarnings(result)

    expect(console.error).not.toHaveBeenCalled()
  })

  it('includes task fields in issue readback text', () => {
    const result = {
      issue: {
        id: 'issue-1',
        identifier: 'ENG-123',
        title: 'Fix task fields',
        url: 'https://linear.app/acme/issue/ENG-123',
        state: { name: 'In Progress' },
        assignee: { displayName: 'Ada' },
        project: null,
        labels: [],
        priority: 2,
        estimate: 5,
        dueDate: '2026-06-30'
      },
      meta: {
        sections: {}
      }
    } as unknown as LinearIssueContextResult

    expect(formatLinearIssue(result)).toContain('Priority: high')
    expect(formatLinearIssue(result)).toContain('Estimate: 5')
    expect(formatLinearIssue(result)).toContain('Due: 2026-06-30')
  })
})

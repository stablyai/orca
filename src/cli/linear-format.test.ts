import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  LinearCreateResult,
  LinearIssueContextResult,
  LinearProjectListResult,
  LinearSearchResult
} from '../shared/linear-agent-access'
import {
  formatLinearCreate,
  formatLinearIssue,
  formatLinearProjectList,
  printLinearSearchWarnings
} from './linear-format'

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

  it('formats project rows with names, ids, teams, and workspace', () => {
    const result = {
      projects: [
        {
          id: 'project-1',
          name: 'Launch',
          workspaceName: 'Acme',
          teams: [
            { id: 'team-1', name: 'Engineering', key: 'ENG' },
            { id: 'team-2', name: 'Product', key: '' }
          ]
        }
      ],
      meta: { limit: 20, returned: 1, hasMore: false, partial: false, workspaceErrors: [] }
    } as unknown as LinearProjectListResult

    const output = formatLinearProjectList(result)

    expect(output).toContain('Launch')
    expect(output).toContain('project-1')
    expect(output).toContain('ENG')
    expect(output).toContain('Product')
    expect(output).toContain('Acme')
  })

  it('includes the project in create output when present', () => {
    const result = {
      issue: {
        id: 'issue-1',
        identifier: 'ENG-123',
        title: 'Follow up',
        url: 'https://linear.app/acme/issue/ENG-123',
        team: { id: 'team-1', key: 'ENG', name: 'Engineering' },
        state: null,
        parent: null,
        project: { id: 'project-1', name: 'Launch' }
      },
      meta: {
        workspaceId: 'workspace-1',
        writeId: '11111111-1111-4111-8111-111111111111',
        deduplicated: false
      }
    } as LinearCreateResult

    expect(formatLinearCreate(result)).toBe('Created ENG-123 in Launch: Follow up.')
  })
})

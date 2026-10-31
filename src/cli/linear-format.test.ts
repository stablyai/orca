import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  LinearCreateResult,
  LinearIssueContextResult,
  LinearMcpIssueListResult,
  LinearProjectListResult,
  LinearSearchResult
} from '../shared/linear/agent-access'
import {
  formatLinearCreate,
  formatLinearIssue,
  formatLinearMcpIssueList,
  formatLinearProjectList,
  printLinearMcpIssueListWarnings,
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

  it('binds a list continuation hint to its Linear workspace', () => {
    printLinearMcpIssueListWarnings({
      issues: [],
      truncated: true,
      meta: {
        limit: 20,
        returned: 20,
        hasMore: true,
        nextCursor: 'next-page',
        orderBy: 'updatedAt',
        workspaceId: 'workspace-1',
        partial: false,
        workspaceErrors: []
      }
    } as LinearMcpIssueListResult)

    expect(console.error).toHaveBeenCalledWith(
      'warning: more results available; next cursor: next-page; continue with --workspace workspace-1'
    )
  })

  it('prints a stdout truncation marker when a list-issues page is partial', () => {
    const output = formatLinearMcpIssueList({
      issues: [
        {
          id: 'issue-1',
          identifier: 'ENG-1',
          title: 'Fix auth',
          url: 'https://linear.app/acme/issue/ENG-1',
          labels: [],
          state: { name: 'In Progress' },
          assignee: { displayName: 'Ada' },
          workspace: { id: 'workspace-1', name: 'Acme' }
        }
      ],
      truncated: true,
      meta: {
        limit: 1,
        returned: 1,
        hasMore: true,
        nextCursor: 'next-page',
        orderBy: 'updatedAt',
        workspaceId: 'workspace-1',
        partial: false,
        workspaceErrors: []
      }
    })

    expect(output).toContain('ENG-1')
    expect(output).toContain('truncated: showing 1')
    expect(output).not.toContain(' of ')
  })

  it('omits the stdout truncation marker when the page is complete', () => {
    const output = formatLinearMcpIssueList({
      issues: [
        {
          id: 'issue-1',
          identifier: 'ENG-1',
          title: 'Fix auth',
          url: 'https://linear.app/acme/issue/ENG-1',
          labels: [],
          workspace: { id: 'workspace-1', name: 'Acme' }
        }
      ],
      truncated: false,
      meta: {
        limit: 50,
        returned: 1,
        hasMore: false,
        orderBy: 'updatedAt',
        workspaceId: 'workspace-1',
        partial: false,
        workspaceErrors: []
      }
    })

    expect(output).toContain('ENG-1')
    expect(output).not.toContain('truncated:')
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

  const OSC_52 = '\u001b]52;c;cGF5bG9hZA==\u0007'
  const CLEAR_SCREEN = '\u001b[2J'

  it('strips escape sequences, C1 bytes and line breaks from issue fields', () => {
    const result: LinearIssueContextResult = {
      issue: {
        id: 'issue-1',
        identifier: 'ENG-123',
        title: `Fix${OSC_52} auth\r\nState: Done`,
        url: 'https://linear.app/acme/issue/ENG-123',
        state: { name: `In Progress${CLEAR_SCREEN}` },
        assignee: { displayName: 'Ada\u009b31m' },
        project: { id: 'project-1', name: 'Launch' },
        labels: [{ id: 'label-1', name: `bug${OSC_52}` }],
        priority: 2,
        estimate: 5
      },
      meta: {
        requested: {
          current: false,
          include: {
            comments: false,
            children: false,
            attachments: false,
            relations: false,
            activity: false
          },
          depth: 0
        },
        resolved: {
          id: 'issue-1',
          identifier: 'ENG-123',
          workspaceId: 'workspace-1',
          workspaceName: 'Acme'
        },
        partial: false,
        includeErrors: [],
        sections: {}
      }
    }

    expect(formatLinearIssue(result)).toBe(
      [
        'ENG-123 Fix auth State: Done',
        'URL: https://linear.app/acme/issue/ENG-123',
        'State: In Progress',
        'Assignee: Ada',
        'Project: Launch',
        'Priority: high',
        'Estimate: 5',
        'Labels: bug'
      ].join('\n')
    )
  })

  it('keeps one aligned row per issue when a title carries a line break', () => {
    const output = formatLinearMcpIssueList({
      issues: [
        {
          id: 'issue-1',
          identifier: 'ENG-1',
          title: `Fix auth\r\nENG-2 Done${CLEAR_SCREEN}`,
          url: 'https://linear.app/acme/issue/ENG-1',
          labels: [],
          state: { name: `In${OSC_52} Progress` },
          assignee: { displayName: 'Ada\u009d0;pwned\u009c' },
          workspace: { id: 'workspace-1', name: 'Acme' }
        }
      ],
      truncated: false,
      meta: {
        limit: 50,
        returned: 1,
        hasMore: false,
        orderBy: 'updatedAt',
        workspaceId: 'workspace-1',
        partial: false,
        workspaceErrors: []
      }
    })

    expect(output).toBe(
      `${'ENG-1'.padEnd(10)} ${'In Progress'.padEnd(14)} ${'Ada'.padEnd(18)} Fix auth ENG-2 Done`
    )
  })

  it('strips control sequences from Linear-provided warning text', () => {
    printLinearMcpIssueListWarnings({
      issues: [],
      truncated: false,
      meta: {
        limit: 20,
        returned: 0,
        hasMore: false,
        orderBy: 'updatedAt',
        workspaceId: 'all',
        partial: true,
        workspaceErrors: [
          {
            workspace: { id: 'workspace-1', name: `Acme${OSC_52}` },
            code: 'linear_rate_limited',
            message: `rate limited\r\nwarning: fake${CLEAR_SCREEN}`
          }
        ]
      }
    })

    expect(console.error).toHaveBeenCalledWith(
      'warning: Acme unavailable for Linear: rate limited warning: fake'
    )
  })
})

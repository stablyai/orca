import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  LinearIssueContextResult,
  LinearTeamMembersResult
} from '../shared/linear/agent-access'
import {
  formatLinearIssue,
  formatLinearMcpIssueList,
  formatLinearTeamMembers,
  printLinearMcpIssueListWarnings
} from './linear-format'

describe('linear-format', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.spyOn(console, 'error').mockImplementation(() => {})
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

  it('pads member names by terminal columns so wide Hangul names keep the id column aligned', () => {
    const result: LinearTeamMembersResult = {
      team: { id: 'team-1', name: 'Engineering', key: 'ENG' },
      members: [
        { id: 'user-0', displayName: '김철수' },
        { id: 'user-1', displayName: 'Alice' }
      ],
      meta: { workspaceId: 'workspace-1', returned: 2 }
    }

    expect(formatLinearTeamMembers(result).split('\n')).toEqual([
      `김철수${' '.repeat(18)} user-0`,
      `Alice${' '.repeat(19)} user-1`
    ])
  })
})

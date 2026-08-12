import { describe, expect, it } from 'vitest'
import type { LinearIssueContextResult } from '../../shared/linear-agent-access'
import { formatRemoteLinearCli } from './ssh-remote-linear-output'

describe('SSH Linear activity output', () => {
  it('shows requested activity in non-json issue output', () => {
    const result: LinearIssueContextResult = {
      issue: {
        id: 'issue-1',
        identifier: 'ENG-123',
        title: 'Fix thing',
        url: 'https://linear.app/acme/issue/ENG-123',
        labels: []
      },
      activity: [{ id: 'history-1', actor: { kind: 'system' }, changes: [] }],
      meta: {
        requested: {
          current: true,
          include: {
            comments: false,
            children: false,
            attachments: false,
            relations: false,
            activity: true
          },
          depth: 2
        },
        resolved: {
          id: 'issue-1',
          identifier: 'ENG-123',
          workspaceId: 'workspace-1',
          workspaceName: 'Acme'
        },
        partial: false,
        includeErrors: [],
        sections: {
          activity: { returned: 1, cap: 250, capReached: false, hasMore: false }
        }
      }
    }

    expect(formatRemoteLinearCli(result)?.stdout).toContain('Activity: 1')
  })
})

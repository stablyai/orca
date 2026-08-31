import { describe, expect, it } from 'vitest'
import { formatRemoteLinearCli } from './ssh-remote-linear-output'

const issue = {
  id: 'issue-1',
  identifier: 'ENG-1',
  title: 'Fix auth',
  url: 'https://linear.app/acme/issue/ENG-1',
  labels: [],
  workspace: { id: 'workspace-1', name: 'Acme' }
}

const mcpListResult = (extra: Record<string, unknown>) => ({
  issues: [issue],
  meta: {
    limit: 1,
    returned: 1,
    hasMore: true,
    orderBy: 'updatedAt',
    workspaceId: 'workspace-1',
    partial: false,
    workspaceErrors: []
  },
  ...extra
})

describe('remote Linear list truncation output', () => {
  it('marks a truncated list-issues page on stdout', () => {
    expect(formatRemoteLinearCli(mcpListResult({ truncated: true }))?.stdout).toContain(
      'truncated: showing 1'
    )
  })

  // A host that predates `truncated` sends only meta.hasMore; absence must not read as complete.
  it('falls back to meta.hasMore when an older host omits truncated', () => {
    expect(formatRemoteLinearCli(mcpListResult({}))?.stdout).toContain('truncated: showing 1')
  })

  it('leaves a complete page unmarked', () => {
    const complete = mcpListResult({ truncated: false })
    complete.meta.hasMore = false
    expect(formatRemoteLinearCli(complete)?.stdout).not.toContain('truncated:')
  })

  it('reports the row count it printed even when meta.returned is missing', () => {
    const withoutReturned = mcpListResult({ truncated: true })
    delete (withoutReturned.meta as { returned?: number }).returned
    expect(formatRemoteLinearCli(withoutReturned)?.stdout).toContain('truncated: showing 1')
  })

  it('prints the provider total for SSH search output', () => {
    const result = {
      issues: [issue],
      totalCount: 349,
      truncated: true,
      meta: {
        query: 'auth',
        limit: 1,
        returned: 1,
        limitReached: true,
        partial: false,
        workspaceErrors: []
      }
    }

    expect(formatRemoteLinearCli(result)?.stdout).toContain('truncated: showing 1 of 349')
    expect(formatRemoteLinearCli(result)?.stderr).toContain(
      'warning: showing 1 of 349 Linear issues'
    )
  })

  it('formats search output from an older host without totalCount', () => {
    const result = {
      issues: [issue],
      truncated: true,
      meta: { query: 'auth', limit: 1, returned: 1, limitReached: true }
    }

    expect(formatRemoteLinearCli(result)?.stdout).toContain('truncated: showing 1')
  })

  it('falls back to raw JSON for malformed provider totals', () => {
    const result = {
      issues: [issue],
      totalCount: '349',
      truncated: true,
      meta: { query: 'auth', limit: 1, returned: 1, limitReached: true }
    }

    expect(formatRemoteLinearCli(result)).toBeNull()
  })

  it('accepts null limits from a new project-list host', () => {
    const result = {
      projects: [{ id: 'project-1', name: 'Launch' }],
      meta: {
        limit: null,
        returned: 1,
        hasMore: false,
        partial: false,
        workspaceErrors: []
      }
    }

    expect(formatRemoteLinearCli(result)?.stdout).toContain('Launch')
  })
})

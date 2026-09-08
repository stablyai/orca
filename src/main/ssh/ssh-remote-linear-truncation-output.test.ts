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
})

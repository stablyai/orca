import { describe, expect, it, vi } from 'vitest'

const ISSUE_NODE = {
  id: 'issue-1',
  identifier: 'ENG-123',
  title: 'Make the export dialog remember the previous format',
  branchName: 'jdoe/eng-123-make-the-export-dialog-remember-the-previous',
  url: 'https://linear.app/acme/issue/ENG-123/make-the-export-dialog',
  priority: 0,
  updatedAt: '2026-11-01T00:00:00.000Z'
}

// Fake Linear GraphQL: a field is only returned when the document selects it.
function respond(query: string): unknown {
  const node: Record<string, unknown> = Object.fromEntries(
    Object.entries(ISSUE_NODE).filter(([field]) =>
      new RegExp(`^\\s*${field}\\s*$`, 'm').test(query)
    )
  )
  const issues = { nodes: [node], pageInfo: { hasNextPage: false, endCursor: null } }
  return query.includes('customView(')
    ? { customView: { id: 'view-1', modelName: 'Issue', issues } }
    : { project: { issues } }
}

vi.mock('../accounts/linear-token-store', () => ({ clearToken: vi.fn() }))
vi.mock('../accounts/linear-account-client', () => ({
  isAuthError: () => false,
  getClients: () => [
    {
      workspace: { id: 'ws-1', organizationName: 'Acme' },
      apiKey: 'key',
      client: {
        client: { rawRequest: async (query: string) => ({ data: respond(query) }) }
      }
    }
  ]
}))

describe('Linear project and custom view issue lists', () => {
  it('carry Linear branchName for workspace creation', async () => {
    const { listProjectIssues } = await import('./linear-project-issue-queries')
    const { listCustomViewIssues } = await import('../custom-views/linear-custom-view-queries')

    const [projectIssues, viewIssues] = await Promise.all([
      listProjectIssues('project-1', 20, 'ws-1', true),
      listCustomViewIssues('view-1', 20, 'ws-1', true)
    ])

    expect(projectIssues.items[0]?.branchName).toBe(
      'jdoe/eng-123-make-the-export-dialog-remember-the-previous'
    )
    expect(viewIssues.items[0]?.branchName).toBe(
      'jdoe/eng-123-make-the-export-dialog-remember-the-previous'
    )
  })
})

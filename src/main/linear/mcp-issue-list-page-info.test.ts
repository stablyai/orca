import { beforeEach, describe, expect, it, vi } from 'vitest'

const { rawRequest } = vi.hoisted(() => ({ rawRequest: vi.fn() }))

vi.mock('./linear-request-concurrency', () => ({
  acquire: vi.fn().mockResolvedValue(undefined),
  release: vi.fn()
}))

vi.mock('./linear-token-store', () => ({
  clearToken: vi.fn()
}))

vi.mock('./client', () => ({
  getClients: () => [
    {
      workspace: {
        id: 'workspace-1',
        organizationId: 'workspace-1',
        organizationName: 'Acme',
        displayName: 'Ada',
        email: 'ada@example.com'
      },
      client: { client: { rawRequest } }
    }
  ],
  getStatus: () => ({ workspaces: [] }),
  isAuthError: () => false,
  getPublicFileUrlClient: (entry: { client: unknown }) => entry.client
}))

import { listMcpIssues } from './mcp-issue-list'

function issueNode(id: string) {
  return {
    id,
    identifier: id.toUpperCase(),
    title: id,
    url: `https://linear.app/acme/issue/${id}`,
    labels: { nodes: [] },
    updatedAt: '2026-11-10T00:00:00.000Z'
  }
}

describe('Linear list pagination evidence', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('does not report a complete list when a later page omits pageInfo', async () => {
    rawRequest
      .mockResolvedValueOnce({
        data: {
          issues: {
            nodes: [issueNode('lin-1'), issueNode('lin-2')],
            pageInfo: { hasNextPage: true, endCursor: 'next' }
          }
        }
      })
      .mockResolvedValueOnce({
        data: { issues: { nodes: [] } }
      })

    await expect(listMcpIssues({})).rejects.toMatchObject({ code: 'linear_partial' })
    expect(rawRequest).toHaveBeenCalledTimes(2)
  })

  it('does not report a complete list when pageInfo.hasNextPage is not boolean', async () => {
    rawRequest.mockResolvedValueOnce({
      data: {
        issues: {
          nodes: [issueNode('lin-1')],
          pageInfo: { hasNextPage: null }
        }
      }
    })

    await expect(listMcpIssues({})).rejects.toMatchObject({ code: 'linear_partial' })
  })

  it('keeps a page with hasNextPage false complete', async () => {
    rawRequest.mockResolvedValueOnce({
      data: {
        issues: {
          nodes: [issueNode('lin-1')],
          pageInfo: { hasNextPage: false, endCursor: null }
        }
      }
    })

    await expect(listMcpIssues({})).resolves.toMatchObject({
      meta: {
        returned: 1,
        hasMore: false,
        partial: false,
        workspaceErrors: []
      }
    })
  })

  it('keeps a null issue connection as an empty complete list', async () => {
    rawRequest.mockResolvedValueOnce({ data: { issues: null } })

    await expect(listMcpIssues({})).resolves.toMatchObject({
      issues: [],
      meta: { returned: 0, hasMore: false, partial: false, workspaceErrors: [] }
    })
  })
})

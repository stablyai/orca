import { beforeEach, describe, expect, it, vi } from 'vitest'

const rawRequest = vi.fn()
const getClients = vi.fn()
const getStatus = vi.fn()
const acquire = vi.fn()
const release = vi.fn()
const clearToken = vi.fn()

const workspace = (id: string, organizationName: string) => ({
  id,
  organizationId: id,
  organizationName,
  displayName: 'Ada',
  email: null
})

const clientEntry = (
  id: string,
  organizationName: string,
  request: ReturnType<typeof vi.fn> = rawRequest
) => ({
  workspace: workspace(id, organizationName),
  client: { client: { rawRequest: request } }
})

vi.mock('./client', () => ({
  acquire,
  release,
  clearToken,
  getClients,
  getStatus,
  isAuthError: () => false
}))

describe('MCP-compatible Linear issue listing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    const entry = clientEntry('workspace-1', 'Acme')
    getClients.mockReturnValue([entry])
    getStatus.mockReturnValue({ workspaces: [entry.workspace] })
  })

  it('passes rich filters, ordering, archive scope, and cursor to Linear', async () => {
    rawRequest.mockResolvedValue({
      data: {
        issues: {
          nodes: [
            {
              id: 'issue-1',
              identifier: 'ENG-1',
              title: 'Fix auth',
              url: 'https://linear.app/acme/issue/ENG-1',
              labels: { nodes: [] },
              createdAt: '2026-07-01T00:00:00.000Z',
              updatedAt: '2026-07-20T00:00:00.000Z'
            }
          ],
          pageInfo: { hasNextPage: true, endCursor: 'next-page' }
        }
      }
    })
    const { listMcpIssues } = await import('./mcp-issue-list')

    const result = await listMcpIssues({
      team: 'ENG',
      label: 'Bug',
      state: 'started',
      assignee: 'me',
      project: 'Launch',
      priority: 2,
      query: 'auth',
      updatedAt: '-P7D',
      cursor: 'current-page',
      orderBy: 'createdAt',
      includeArchived: true,
      limit: 100,
      workspaceId: 'workspace-1'
    })

    expect(rawRequest).toHaveBeenCalledWith(
      expect.stringContaining('query OrcaLinearListIssues'),
      expect.objectContaining({
        first: 100,
        after: 'current-page',
        orderBy: 'createdAt',
        includeArchived: true,
        filter: expect.objectContaining({
          searchableContent: { contains: 'auth' },
          priority: { eq: 2 },
          updatedAt: { gte: '-P7D' },
          assignee: { isMe: { eq: true } },
          state: {
            or: expect.arrayContaining([{ type: { eqIgnoreCase: 'started' } }])
          },
          project: {
            or: expect.arrayContaining([{ slugId: { eqIgnoreCase: 'Launch' } }])
          }
        })
      })
    )
    expect(rawRequest.mock.calls[0]?.[1]).not.toMatchObject({
      filter: { team: { or: expect.arrayContaining([{ id: { eq: 'ENG' } }]) } }
    })
    expect(result.meta).toMatchObject({
      limit: 100,
      returned: 1,
      hasMore: true,
      nextCursor: 'next-page',
      orderBy: 'createdAt'
    })
    expect(result.issues[0]).toMatchObject({
      identifier: 'ENG-1',
      workspace: { id: 'workspace-1', name: 'Acme' }
    })
  })

  it('uses null filters and clamps direct callers to the MCP maximum', async () => {
    rawRequest.mockResolvedValue({
      data: { issues: { nodes: [], pageInfo: { hasNextPage: false } } }
    })
    const { listMcpIssues } = await import('./mcp-issue-list')

    const result = await listMcpIssues({ assignee: 'null', parentId: 'null', limit: 999 })

    expect(rawRequest.mock.calls[0]?.[1]).toMatchObject({
      first: 250,
      filter: { assignee: { null: true }, parent: { null: true } }
    })
    expect(result.meta.workspaceId).toBe('workspace-1')
  })

  it('uses UUID comparators only for values Linear accepts as IDs', async () => {
    rawRequest.mockResolvedValue({
      data: { issues: { nodes: [], pageInfo: { hasNextPage: false } } }
    })
    const { listMcpIssues } = await import('./mcp-issue-list')
    const teamId = 'edece093-2649-4b21-9bf6-ff9192adf4f7'
    const assigneeId = '256097b4-4dc3-4722-b5c3-888faa672554'
    const parentId = 'c1097b4f-fa53-49da-ab5d-a38c596fbb5f'

    await listMcpIssues({ team: teamId, assignee: assigneeId, parentId })

    expect(rawRequest.mock.calls[0]?.[1]).toMatchObject({
      filter: {
        team: { or: expect.arrayContaining([{ id: { eq: teamId } }]) },
        assignee: { or: expect.arrayContaining([{ id: { eq: assigneeId } }]) },
        parent: { id: { eq: parentId } }
      }
    })
  })

  it('fans out one bounded provider request per workspace concurrently', async () => {
    const firstRequest = vi.fn()
    const secondRequest = vi.fn()
    let resolveFirst: ((value: unknown) => void) | undefined
    let resolveSecond: ((value: unknown) => void) | undefined
    firstRequest.mockImplementation(
      () => new Promise((resolve) => (resolveFirst = resolve as (value: unknown) => void))
    )
    secondRequest.mockImplementation(
      () => new Promise((resolve) => (resolveSecond = resolve as (value: unknown) => void))
    )
    const firstEntry = clientEntry('workspace-1', 'Acme', firstRequest)
    const secondEntry = clientEntry('workspace-2', 'Beta', secondRequest)
    getStatus.mockReturnValue({ workspaces: [firstEntry.workspace, secondEntry.workspace] })
    getClients.mockImplementation((workspaceId) => {
      if (workspaceId === 'workspace-1') {
        return [firstEntry]
      }
      if (workspaceId === 'workspace-2') {
        return [secondEntry]
      }
      return []
    })
    const { listMcpIssues } = await import('./mcp-issue-list')

    const pending = listMcpIssues({ limit: 1, workspaceId: 'all' })
    await vi.waitFor(() => {
      expect(firstRequest).toHaveBeenCalledTimes(1)
      expect(secondRequest).toHaveBeenCalledTimes(1)
    })
    resolveFirst?.({
      data: {
        issues: {
          nodes: [issueNode('issue-1', 'ENG-1', '2026-07-01T00:00:00.000Z')],
          pageInfo: { hasNextPage: false, endCursor: 'first-cursor' }
        }
      }
    })
    resolveSecond?.({
      data: {
        issues: {
          nodes: [issueNode('issue-2', 'OPS-1', '2026-07-02T00:00:00.000Z')],
          pageInfo: { hasNextPage: false, endCursor: 'second-cursor' }
        }
      }
    })

    const result = await pending
    expect(result.issues.map((issue) => issue.identifier)).toEqual(['OPS-1'])
    expect(result.meta).toMatchObject({ returned: 1, hasMore: true, partial: false })
    expect(result.meta.nextCursor).toBeUndefined()
    expect(firstRequest.mock.calls[0]?.[1]).toMatchObject({ first: 1 })
    expect(secondRequest.mock.calls[0]?.[1]).toMatchObject({ first: 1 })
  })

  it('returns healthy workspace results with a classified partial failure', async () => {
    const healthyRequest = vi.fn().mockResolvedValue({
      data: {
        issues: {
          nodes: [issueNode('issue-1', 'ENG-1', '2026-07-01T00:00:00.000Z')],
          pageInfo: { hasNextPage: false }
        }
      }
    })
    const failedRequest = vi.fn().mockRejectedValue(new Error('429 rate limit exceeded'))
    const healthy = clientEntry('workspace-1', 'Acme', healthyRequest)
    const failed = clientEntry('workspace-2', 'Beta', failedRequest)
    getStatus.mockReturnValue({ workspaces: [healthy.workspace, failed.workspace] })
    getClients.mockImplementation((workspaceId) => {
      if (workspaceId === 'workspace-1') {
        return [healthy]
      }
      if (workspaceId === 'workspace-2') {
        return [failed]
      }
      return []
    })
    const { listMcpIssues } = await import('./mcp-issue-list')

    const result = await listMcpIssues({ workspaceId: 'all' })

    expect(result.issues.map((issue) => issue.identifier)).toEqual(['ENG-1'])
    expect(result.meta).toMatchObject({ partial: true, returned: 1 })
    expect(result.meta.workspaceErrors).toEqual([
      {
        workspace: { id: 'workspace-2', name: 'Beta' },
        code: 'linear_rate_limited',
        message: '429 rate limit exceeded'
      }
    ])
  })

  it('rejects workspace-specific cursors for all-workspace reads with a useful code', async () => {
    const { listMcpIssues } = await import('./mcp-issue-list')

    await expect(listMcpIssues({ cursor: 'next', workspaceId: 'all' })).rejects.toMatchObject({
      code: 'linear_invalid_workspace'
    })
    expect(rawRequest).not.toHaveBeenCalled()
  })

  it('requires a workspace for cursor replay and does not emit fanout cursors', async () => {
    rawRequest.mockResolvedValue({
      data: {
        issues: {
          nodes: [issueNode('issue-1', 'ENG-1', '2026-07-01T00:00:00.000Z')],
          pageInfo: { hasNextPage: true, endCursor: 'workspace-cursor' }
        }
      }
    })
    const { listMcpIssues } = await import('./mcp-issue-list')

    await expect(listMcpIssues({ cursor: 'next' })).rejects.toMatchObject({
      code: 'linear_invalid_workspace'
    })
    const result = await listMcpIssues({ workspaceId: 'all' })

    expect(result.meta).toMatchObject({ hasMore: true, workspaceId: 'all' })
    expect(result.meta.nextCursor).toBeUndefined()
    expect(rawRequest).toHaveBeenCalledTimes(1)
  })

  it('rejects unknown explicit workspaces instead of returning an empty list', async () => {
    getClients.mockReturnValue([])
    const { listMcpIssues } = await import('./mcp-issue-list')

    await expect(listMcpIssues({ workspaceId: 'workspace-missing' })).rejects.toMatchObject({
      code: 'linear_invalid_workspace'
    })
    expect(rawRequest).not.toHaveBeenCalled()
  })
})

function issueNode(id: string, identifier: string, updatedAt: string) {
  return {
    id,
    identifier,
    title: `Issue ${identifier}`,
    url: `https://linear.app/acme/issue/${identifier}`,
    labels: { nodes: [] },
    createdAt: updatedAt,
    updatedAt
  }
}

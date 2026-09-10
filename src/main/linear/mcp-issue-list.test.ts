import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
  apiKey: id,
  client: { options: { apiKey: id }, client: { rawRequest: request } }
})

vi.mock('./linear-request-concurrency', () => ({
  acquire,
  release,
  reserveLinearListing: () => () => {}
}))

vi.mock('./linear-token-store', () => ({
  clearToken
}))

vi.mock('./client', () => ({
  getClients,
  getStatus,
  isAuthError: () => false
}))

describe('MCP-compatible Linear issue listing', () => {
  afterEach(() => vi.unstubAllGlobals())
  beforeEach(() => {
    vi.clearAllMocks()
    const entry = clientEntry('workspace-1', 'Acme')
    getClients.mockReturnValue([entry])
    getStatus.mockReturnValue({ workspaces: [entry.workspace] })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, options) => {
        const { query, variables } = JSON.parse(options.body)
        const selected = getClients(options.headers.get('Authorization'))[0]
        const body = await selected.client.client.rawRequest(query, variables)
        return body instanceof Response ? body : Response.json(body)
      })
    )
  })

  it('passes rich filters, ordering, archive scope, and cursor to Linear', async () => {
    rawRequest.mockResolvedValue({
      data: {
        issues: {
          nodes: Array.from({ length: 100 }, (_unused, index) => ({
            id: `issue-${index + 1}`,
            identifier: `ENG-${index + 1}`,
            title: 'Fix auth',
            url: `https://linear.app/acme/issue/ENG-${index + 1}`,
            labels: { nodes: [] },
            createdAt: '2026-07-01T00:00:00.000Z',
            updatedAt: '2026-07-20T00:00:00.000Z'
          })),
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
    expect(result.truncated).toBe(true)
    expect(result.meta).toMatchObject({
      limit: 100,
      returned: 100,
      hasMore: true,
      orderBy: 'createdAt'
    })
    // Stops at the requested cap instead of walking on.
    expect(rawRequest).toHaveBeenCalledTimes(1)
    expect(result.meta.nextCursor).toMatch(/^orca\.linear\.v1\./)
    expect(result.issues[0]).toMatchObject({
      identifier: 'ENG-1',
      workspace: { id: 'workspace-1', name: 'Acme' }
    })
  })

  it('uses null filters and pages at the Linear per-request maximum', async () => {
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

  it('takes one provider page at a time and sorts the admitted batch', async () => {
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

    const pending = listMcpIssues({ limit: 2, workspaceId: 'all', pageRecovery: { version: 1 } })
    await vi.waitFor(() => {
      expect(firstRequest).toHaveBeenCalledTimes(1)
      expect(secondRequest).not.toHaveBeenCalled()
    })
    resolveFirst?.({
      data: {
        issues: {
          nodes: [issueNode('issue-1', 'ENG-1', '2026-07-01T00:00:00.000Z')],
          pageInfo: { hasNextPage: false, endCursor: 'first-cursor' }
        }
      }
    })
    await vi.waitFor(() => expect(secondRequest).toHaveBeenCalledTimes(1))
    resolveSecond?.({
      data: {
        issues: {
          nodes: [issueNode('issue-2', 'OPS-1', '2026-07-02T00:00:00.000Z')],
          pageInfo: { hasNextPage: false, endCursor: 'second-cursor' }
        }
      }
    })

    const result = await pending
    expect(result.issues.map((issue) => issue.identifier)).toEqual(['OPS-1', 'ENG-1'])
    expect(result.meta).toMatchObject({ returned: 2, hasMore: false, partial: false })
    expect(result.meta.nextCursor).toBeUndefined()
    expect(firstRequest.mock.calls[0]?.[1]).toMatchObject({ first: 2 })
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
    const failedRequest = vi.fn().mockResolvedValue(new Response('rate limited', { status: 429 }))
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

    const result = await listMcpIssues({ workspaceId: 'all', pageRecovery: { version: 1 } })

    expect(result.issues.map((issue) => issue.identifier)).toEqual(['ENG-1'])
    expect(result.meta).toMatchObject({ partial: true, returned: 1 })
    expect(result.meta.workspaceErrors).toMatchObject([
      {
        workspace: { id: 'workspace-2', name: 'Beta' },
        code: 'linear_rate_limited',
        message: 'Linear provider request failed (HTTP 429).'
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
    const result = await listMcpIssues({
      workspaceId: 'all',
      limit: 1,
      pageRecovery: { version: 1 }
    })

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

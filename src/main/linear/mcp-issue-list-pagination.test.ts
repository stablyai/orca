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

const clientEntry = (id: string, organizationName: string) => ({
  workspace: workspace(id, organizationName),
  client: { client: { rawRequest } }
})

vi.mock('./linear-request-concurrency', () => ({
  acquire,
  release
}))

vi.mock('./linear-token-store', () => ({
  clearToken
}))

vi.mock('./client', () => ({
  getClients,
  getStatus,
  isAuthError: () => false
}))

function issueNode(id: string, identifier: string, updatedAt: string, priority?: number) {
  return {
    id,
    identifier,
    title: `Issue ${identifier}`,
    url: `https://linear.app/acme/issue/${identifier}`,
    labels: { nodes: [] },
    createdAt: updatedAt,
    updatedAt,
    ...(priority === undefined ? {} : { priority })
  }
}

function pageResponse(
  nodes: ReturnType<typeof issueNode>[],
  hasNextPage: boolean,
  endCursor?: string
) {
  return {
    data: {
      issues: {
        nodes,
        pageInfo: { hasNextPage, endCursor: endCursor ?? null }
      }
    }
  }
}

describe('list-issues pagination contract', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    const entry = clientEntry('workspace-1', 'Acme')
    getClients.mockReturnValue([entry])
    getStatus.mockReturnValue({ workspaces: [entry.workspace] })
  })

  it('marks a full page with more results as truncated and binds workspace into nextCursor', async () => {
    rawRequest.mockResolvedValue(
      pageResponse(
        [issueNode('issue-1', 'ENG-1', '2026-07-01T00:00:00.000Z', 1)],
        true,
        'linear-end'
      )
    )
    const { listMcpIssues } = await import('./mcp-issue-list')

    const result = await listMcpIssues({ limit: 1, workspaceId: 'workspace-1' })

    expect(result.issues).toHaveLength(1)
    expect(result.truncated).toBe(true)
    expect(result.meta.hasMore).toBe(true)
    expect(result.meta.nextCursor).toMatch(/^orca\.linear\.v1\./)
    expect(result.issues[0]?.priorityLabel).toBe('urgent')
  })

  it('does not mark a short complete page as truncated', async () => {
    rawRequest.mockResolvedValue(
      pageResponse([issueNode('issue-1', 'ENG-1', '2026-07-01T00:00:00.000Z')], false)
    )
    const { listMcpIssues } = await import('./mcp-issue-list')

    const result = await listMcpIssues({ limit: 50 })

    expect(result.truncated).toBe(false)
    expect(result.meta.hasMore).toBe(false)
    expect(result.meta.nextCursor).toBeUndefined()
  })

  it('does not mark an exact-limit complete page as truncated', async () => {
    rawRequest.mockResolvedValue(
      pageResponse([issueNode('issue-1', 'ENG-1', '2026-07-01T00:00:00.000Z')], false, 'unused')
    )
    const { listMcpIssues } = await import('./mcp-issue-list')

    const result = await listMcpIssues({ limit: 1 })

    expect(result.issues).toHaveLength(1)
    expect(result.truncated).toBe(false)
  })

  it('replays an issued cursor without --workspace', async () => {
    rawRequest.mockResolvedValueOnce(
      pageResponse([issueNode('issue-1', 'ENG-1', '2026-07-01T00:00:00.000Z')], true, 'linear-end')
    )
    const { listMcpIssues } = await import('./mcp-issue-list')
    const first = await listMcpIssues({ limit: 1 })

    rawRequest.mockResolvedValueOnce(
      pageResponse([issueNode('issue-2', 'ENG-2', '2026-07-02T00:00:00.000Z')], false)
    )
    const second = await listMcpIssues({ limit: 1, cursor: first.meta.nextCursor })

    expect(second.issues[0]?.identifier).toBe('ENG-2')
    expect(rawRequest.mock.calls[1]?.[1]).toMatchObject({ after: 'linear-end' })
    expect(getClients.mock.calls[1]?.[0]).toBe('workspace-1')
  })

  it('rejects a raw cursor without workspace and includes nextSteps', async () => {
    const { listMcpIssues } = await import('./mcp-issue-list')

    await expect(listMcpIssues({ cursor: 'linear-end' })).rejects.toMatchObject({
      code: 'linear_invalid_workspace',
      data: {
        nextSteps: expect.arrayContaining([
          expect.stringContaining('--workspace'),
          expect.stringContaining('nextCursor')
        ])
      }
    })
    expect(rawRequest).not.toHaveBeenCalled()
  })

  it('rejects a wrapped cursor that disagrees with --workspace', async () => {
    rawRequest.mockResolvedValue(
      pageResponse([issueNode('issue-1', 'ENG-1', '2026-07-01T00:00:00.000Z')], true, 'linear-end')
    )
    const { listMcpIssues } = await import('./mcp-issue-list')
    const first = await listMcpIssues({ limit: 1, workspaceId: 'workspace-1' })

    await expect(
      listMcpIssues({ cursor: first.meta.nextCursor, workspaceId: 'workspace-other' })
    ).rejects.toMatchObject({
      code: 'linear_invalid_workspace',
      data: { nextSteps: expect.any(Array) }
    })
  })

  it('walks every page when no limit is set and reports a complete read', async () => {
    rawRequest
      .mockResolvedValueOnce(
        pageResponse([issueNode('issue-1', 'ENG-1', '2026-07-03T00:00:00.000Z')], true, 'page-2')
      )
      .mockResolvedValueOnce(
        pageResponse([issueNode('issue-2', 'ENG-2', '2026-07-02T00:00:00.000Z')], true, 'page-3')
      )
      .mockResolvedValueOnce(
        pageResponse([issueNode('issue-3', 'ENG-3', '2026-07-01T00:00:00.000Z')], false)
      )
    const { listMcpIssues } = await import('./mcp-issue-list')

    const result = await listMcpIssues({})

    expect(result.issues.map((issue) => issue.identifier)).toEqual(['ENG-1', 'ENG-2', 'ENG-3'])
    expect(result.truncated).toBe(false)
    expect(result.meta).toMatchObject({ limit: null, returned: 3, hasMore: false })
    expect(result.meta.nextCursor).toBeUndefined()
    expect(rawRequest.mock.calls.map((call) => call[1]?.after)).toEqual([
      undefined,
      'page-2',
      'page-3'
    ])
    expect(rawRequest.mock.calls[0]?.[1]).toMatchObject({ first: 250 })
  })

  it('pages past the Linear per-request maximum to satisfy a larger explicit limit', async () => {
    const page = (start: number, count: number, hasNextPage: boolean, endCursor?: string) =>
      pageResponse(
        Array.from({ length: count }, (_unused, index) =>
          issueNode(`issue-${start + index}`, `ENG-${start + index}`, '2026-07-01T00:00:00.000Z')
        ),
        hasNextPage,
        endCursor
      )
    rawRequest
      .mockResolvedValueOnce(page(1, 250, true, 'page-2'))
      .mockResolvedValueOnce(page(251, 50, true, 'page-3'))
    const { listMcpIssues } = await import('./mcp-issue-list')

    const result = await listMcpIssues({ limit: 300 })

    expect(result.issues).toHaveLength(300)
    expect(result.truncated).toBe(true)
    expect(result.meta).toMatchObject({ limit: 300, returned: 300, hasMore: true })
    expect(rawRequest.mock.calls.map((call) => call[1]?.first)).toEqual([250, 50])
  })

  it('stops and reports truncation when a provider never stops offering pages', async () => {
    rawRequest.mockResolvedValue(
      pageResponse([issueNode('issue-1', 'ENG-1', '2026-07-01T00:00:00.000Z')], true, 'same-cursor')
    )
    const { listMcpIssues } = await import('./mcp-issue-list')

    const result = await listMcpIssues({})

    expect(result.truncated).toBe(true)
    expect(result.meta.hasMore).toBe(true)
    expect(rawRequest.mock.calls.length).toBeLessThanOrEqual(200)
    expect(result.meta.nextCursor).toMatch(/^orca\.linear\.v1\./)
  })

  it('stops paging when a page claims more results but hands back no cursor', async () => {
    rawRequest.mockResolvedValue(
      pageResponse([issueNode('issue-1', 'ENG-1', '2026-07-01T00:00:00.000Z')], true)
    )
    const { listMcpIssues } = await import('./mcp-issue-list')

    const result = await listMcpIssues({})

    expect(rawRequest).toHaveBeenCalledTimes(1)
    expect(result.truncated).toBe(true)
    expect(result.meta.nextCursor).toBeUndefined()
  })

  it('stops on the read budget and hands back a cursor instead of outliving the RPC', async () => {
    vi.useFakeTimers()
    try {
      let issued = 0
      rawRequest.mockImplementation(() => {
        issued += 1
        vi.advanceTimersByTime(11_000)
        return Promise.resolve(
          pageResponse(
            [issueNode(`issue-${issued}`, `ENG-${issued}`, '2026-07-01T00:00:00.000Z')],
            true,
            `page-${issued}`
          )
        )
      })
      const { listMcpIssues } = await import('./mcp-issue-list')

      const result = await listMcpIssues({})

      expect(issued).toBe(2)
      expect(result.truncated).toBe(true)
      expect(result.meta.nextCursor).toMatch(/^orca\.linear\.v1\./)
    } finally {
      vi.useRealTimers()
    }
  })

  it('refuses a hand-crafted cursor that smuggles a fan-out or empty workspace', async () => {
    const { encodeIssueListCursor } = await import('./mcp-issue-list-cursor')
    const { listMcpIssues } = await import('./mcp-issue-list')

    for (const workspaceId of ['all', '']) {
      await expect(
        listMcpIssues({ cursor: encodeIssueListCursor(workspaceId, 'linear-end') })
      ).rejects.toMatchObject({ code: 'linear_invalid_workspace' })
    }
    await expect(
      listMcpIssues({ cursor: encodeIssueListCursor('workspace-1', '') })
    ).rejects.toMatchObject({ code: 'linear_invalid_workspace' })
    expect(rawRequest).not.toHaveBeenCalled()
  })

  it('maps every Linear priority number onto the CLI setter label', async () => {
    rawRequest.mockResolvedValue(
      pageResponse(
        [0, 1, 2, 3, 4].map((priority) =>
          issueNode(`issue-${priority}`, `ENG-${priority}`, '2026-07-01T00:00:00.000Z', priority)
        ),
        false
      )
    )
    const { listMcpIssues } = await import('./mcp-issue-list')

    const result = await listMcpIssues({ limit: 10 })

    expect(result.issues.map((issue) => issue.priorityLabel)).toEqual([
      'none',
      'urgent',
      'high',
      'medium',
      'low'
    ])
  })
})

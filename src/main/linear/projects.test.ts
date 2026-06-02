import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LinearClientForWorkspace } from './client'

const rawRequest = vi.fn()
const getClients = vi.fn()
const clearToken = vi.fn()

vi.mock('./client', () => ({
  acquire: vi.fn().mockResolvedValue(undefined),
  release: vi.fn(),
  getClients: (...args: unknown[]) => getClients(...args),
  isAuthError: vi.fn().mockReturnValue(false),
  clearToken: (...args: unknown[]) => clearToken(...args)
}))

function makeEntry(): LinearClientForWorkspace {
  return {
    workspace: {
      id: 'workspace-1',
      organizationId: 'workspace-1',
      organizationName: 'Workspace',
      displayName: 'Ada',
      email: 'ada@example.com'
    },
    client: {
      client: { rawRequest }
    }
  } as unknown as LinearClientForWorkspace
}

function rawIssue(id: string) {
  return {
    id,
    identifier: id,
    title: id,
    url: `https://linear.app/${id}`,
    priority: 0,
    updatedAt: '2026-01-01T00:00:00.000Z',
    labelIds: [],
    state: { name: 'Todo', type: 'unstarted', color: '#888888' },
    team: { id: 'team-1', name: 'Team', key: 'TM' },
    labels: { nodes: [] }
  }
}

function rawProject(id: string) {
  return {
    id,
    name: id
  }
}

function rawCustomView(id: string) {
  return {
    id,
    name: id,
    modelName: 'Project'
  }
}

function projectIssuesResponse(issueId: string) {
  return projectIssuesConnectionResponse([issueId])
}

function projectIssuesConnectionResponse(
  issueIds: string[],
  pageInfo: { hasNextPage: boolean; endCursor?: string | null } = { hasNextPage: false }
) {
  return {
    data: {
      project: {
        issues: {
          nodes: issueIds.map((issueId) => rawIssue(issueId)),
          pageInfo
        }
      }
    }
  }
}

function customViewsResponse(viewId: string) {
  return {
    data: {
      customViews: {
        nodes: [rawCustomView(viewId)],
        pageInfo: { hasNextPage: false }
      }
    }
  }
}

function customViewResponse(viewId: string) {
  return {
    data: {
      customView: rawCustomView(viewId)
    }
  }
}

function customViewProjectsResponse(projectId: string) {
  return {
    data: {
      customView: {
        modelName: 'Project',
        projects: {
          nodes: [rawProject(projectId)],
          pageInfo: { hasNextPage: false }
        }
      }
    }
  }
}

function customViewIssuesResponse(issueId: string) {
  return customViewIssuesConnectionResponse([issueId])
}

function customViewIssuesConnectionResponse(
  issueIds: string[],
  pageInfo: { hasNextPage: boolean; endCursor?: string | null } = { hasNextPage: false }
) {
  return {
    data: {
      customView: {
        modelName: 'Issue',
        issues: {
          nodes: issueIds.map((issueId) => rawIssue(issueId)),
          pageInfo
        }
      }
    }
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

describe('Linear project queries', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    getClients.mockReturnValue([makeEntry()])
  })

  it('lets manual project issue refresh bypass older in-flight reads', async () => {
    const staleRequest = deferred<ReturnType<typeof projectIssuesResponse>>()
    const refreshRequest = deferred<ReturnType<typeof projectIssuesResponse>>()
    rawRequest.mockReturnValueOnce(staleRequest.promise).mockReturnValueOnce(refreshRequest.promise)
    const { listProjectIssues } = await import('./projects')

    const stalePromise = listProjectIssues('project-1', 20, 'workspace-1')
    const refreshPromise = listProjectIssues('project-1', 20, 'workspace-1', true)

    await vi.waitFor(() => expect(rawRequest).toHaveBeenCalledTimes(2))

    refreshRequest.resolve(projectIssuesResponse('LIN-FRESH'))
    await expect(refreshPromise).resolves.toMatchObject({
      items: [{ id: 'LIN-FRESH' }]
    })

    staleRequest.resolve(projectIssuesResponse('LIN-STALE'))
    await expect(stalePromise).resolves.toMatchObject({
      items: [{ id: 'LIN-STALE' }]
    })
  })

  it('loads project issue reads above Linear connection page size', async () => {
    rawRequest
      .mockResolvedValueOnce(
        projectIssuesConnectionResponse(
          Array.from({ length: 50 }, (_, index) => `LIN-${index + 1}`),
          { hasNextPage: true, endCursor: 'project-cursor-50' }
        )
      )
      .mockResolvedValueOnce(
        projectIssuesConnectionResponse(
          Array.from({ length: 50 }, (_, index) => `LIN-${index + 51}`),
          { hasNextPage: true, endCursor: 'project-cursor-100' }
        )
      )
      .mockResolvedValueOnce(
        projectIssuesConnectionResponse(
          Array.from({ length: 20 }, (_, index) => `LIN-${index + 101}`),
          { hasNextPage: false }
        )
      )
    const { listProjectIssues } = await import('./projects')

    const result = await listProjectIssues('project-1', 120, 'workspace-1')

    expect(result.items).toHaveLength(120)
    expect(result.hasMore).toBe(false)
    expect(rawRequest).toHaveBeenCalledTimes(3)
    expect(rawRequest.mock.calls[0]?.[1]).toMatchObject({ id: 'project-1', first: 50 })
    expect(rawRequest.mock.calls[0]?.[1]).not.toHaveProperty('after')
    expect(rawRequest.mock.calls[1]?.[1]).toMatchObject({
      id: 'project-1',
      first: 50,
      after: 'project-cursor-50'
    })
    expect(rawRequest.mock.calls[2]?.[1]).toMatchObject({
      id: 'project-1',
      first: 20,
      after: 'project-cursor-100'
    })
  })

  it('lets manual custom view list refresh bypass older in-flight reads', async () => {
    const staleRequest = deferred<ReturnType<typeof customViewsResponse>>()
    const refreshRequest = deferred<ReturnType<typeof customViewsResponse>>()
    rawRequest.mockReturnValueOnce(staleRequest.promise).mockReturnValueOnce(refreshRequest.promise)
    const { listCustomViews } = await import('./projects')

    const stalePromise = listCustomViews('project', 20, 'workspace-1')
    const refreshPromise = listCustomViews('project', 20, 'workspace-1', true)

    await vi.waitFor(() => expect(rawRequest).toHaveBeenCalledTimes(2))

    refreshRequest.resolve(customViewsResponse('VIEW-FRESH'))
    await expect(refreshPromise).resolves.toMatchObject({
      items: [{ id: 'VIEW-FRESH' }]
    })

    staleRequest.resolve(customViewsResponse('VIEW-STALE'))
    await expect(stalePromise).resolves.toMatchObject({
      items: [{ id: 'VIEW-STALE' }]
    })
  })

  it('lets forced exact custom view reads bypass older in-flight reads', async () => {
    const staleRequest = deferred<ReturnType<typeof customViewResponse>>()
    const refreshRequest = deferred<ReturnType<typeof customViewResponse>>()
    rawRequest.mockReturnValueOnce(staleRequest.promise).mockReturnValueOnce(refreshRequest.promise)
    const { getCustomView } = await import('./projects')

    const stalePromise = getCustomView('view-1', 'project', 'workspace-1')
    const refreshPromise = getCustomView('view-1', 'project', 'workspace-1', true)

    await vi.waitFor(() => expect(rawRequest).toHaveBeenCalledTimes(2))

    refreshRequest.resolve(customViewResponse('VIEW-FRESH'))
    await expect(refreshPromise).resolves.toMatchObject({ id: 'VIEW-FRESH' })

    staleRequest.resolve(customViewResponse('VIEW-STALE'))
    await expect(stalePromise).resolves.toMatchObject({ id: 'VIEW-STALE' })
  })

  it('lets manual custom view project refresh bypass older in-flight reads', async () => {
    const staleRequest = deferred<ReturnType<typeof customViewProjectsResponse>>()
    const refreshRequest = deferred<ReturnType<typeof customViewProjectsResponse>>()
    rawRequest.mockReturnValueOnce(staleRequest.promise).mockReturnValueOnce(refreshRequest.promise)
    const { listCustomViewProjects } = await import('./projects')

    const stalePromise = listCustomViewProjects('view-1', 20, 'workspace-1')
    const refreshPromise = listCustomViewProjects('view-1', 20, 'workspace-1', true)

    await vi.waitFor(() => expect(rawRequest).toHaveBeenCalledTimes(2))

    refreshRequest.resolve(customViewProjectsResponse('PROJECT-FRESH'))
    await expect(refreshPromise).resolves.toMatchObject({
      items: [{ id: 'PROJECT-FRESH' }]
    })

    staleRequest.resolve(customViewProjectsResponse('PROJECT-STALE'))
    await expect(stalePromise).resolves.toMatchObject({
      items: [{ id: 'PROJECT-STALE' }]
    })
  })

  it('lets manual custom view issue refresh bypass older in-flight reads', async () => {
    const staleRequest = deferred<ReturnType<typeof customViewIssuesResponse>>()
    const refreshRequest = deferred<ReturnType<typeof customViewIssuesResponse>>()
    rawRequest.mockReturnValueOnce(staleRequest.promise).mockReturnValueOnce(refreshRequest.promise)
    const { listCustomViewIssues } = await import('./projects')

    const stalePromise = listCustomViewIssues('view-1', 20, 'workspace-1')
    const refreshPromise = listCustomViewIssues('view-1', 20, 'workspace-1', true)

    await vi.waitFor(() => expect(rawRequest).toHaveBeenCalledTimes(2))

    refreshRequest.resolve(customViewIssuesResponse('ISSUE-FRESH'))
    await expect(refreshPromise).resolves.toMatchObject({
      items: [{ id: 'ISSUE-FRESH' }]
    })

    staleRequest.resolve(customViewIssuesResponse('ISSUE-STALE'))
    await expect(stalePromise).resolves.toMatchObject({
      items: [{ id: 'ISSUE-STALE' }]
    })
  })

  it('loads issue custom view reads above Linear connection page size', async () => {
    rawRequest
      .mockResolvedValueOnce(
        customViewIssuesConnectionResponse(
          Array.from({ length: 50 }, (_, index) => `ISSUE-${index + 1}`),
          { hasNextPage: true, endCursor: 'view-cursor-50' }
        )
      )
      .mockResolvedValueOnce(
        customViewIssuesConnectionResponse(
          Array.from({ length: 50 }, (_, index) => `ISSUE-${index + 51}`),
          { hasNextPage: true, endCursor: 'view-cursor-100' }
        )
      )
      .mockResolvedValueOnce(
        customViewIssuesConnectionResponse(
          Array.from({ length: 20 }, (_, index) => `ISSUE-${index + 101}`),
          { hasNextPage: false }
        )
      )
    const { listCustomViewIssues } = await import('./projects')

    const result = await listCustomViewIssues('view-1', 120, 'workspace-1')

    expect(result.items).toHaveLength(120)
    expect(result.hasMore).toBe(false)
    expect(rawRequest).toHaveBeenCalledTimes(3)
    expect(rawRequest.mock.calls[0]?.[1]).toMatchObject({ id: 'view-1', first: 50 })
    expect(rawRequest.mock.calls[0]?.[1]).not.toHaveProperty('after')
    expect(rawRequest.mock.calls[1]?.[1]).toMatchObject({
      id: 'view-1',
      first: 50,
      after: 'view-cursor-50'
    })
    expect(rawRequest.mock.calls[2]?.[1]).toMatchObject({
      id: 'view-1',
      first: 20,
      after: 'view-cursor-100'
    })
  })
})

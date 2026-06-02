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
  return {
    data: {
      project: {
        issues: {
          nodes: [rawIssue(issueId)],
          pageInfo: { hasNextPage: false }
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
  return {
    data: {
      customView: {
        modelName: 'Issue',
        issues: {
          nodes: [rawIssue(issueId)],
          pageInfo: { hasNextPage: false }
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
})

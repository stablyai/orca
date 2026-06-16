import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LinearClientForWorkspace } from './client'
import { credentialDecryptionMessage } from '../../shared/integration-credential-errors'

const rawRequest = vi.fn()
const getClients = vi.fn()
const clearToken = vi.fn()
const isAuthError = vi.fn()

vi.mock('./client', () => ({
  acquire: vi.fn().mockResolvedValue(undefined),
  release: vi.fn(),
  getClients: (...args: unknown[]) => getClients(...args),
  isAuthError: (...args: unknown[]) => isAuthError(...args),
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

function rawProjectWithName(id: string, name: string) {
  return {
    ...rawProject(id),
    name
  }
}

function projectSearchConnectionResponse(
  projects: ReturnType<typeof rawProject>[],
  pageInfo: { hasNextPage: boolean; endCursor?: string | null } = { hasNextPage: false }
) {
  return {
    data: {
      searchProjects: {
        nodes: projects,
        pageInfo
      }
    }
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

function projectTeamsConnectionResponse(
  teamIds: string[],
  pageInfo: { hasNextPage: boolean; endCursor?: string | null } = { hasNextPage: false }
) {
  return {
    data: {
      project: {
        teams: {
          nodes: teamIds.map((teamId) => ({ id: teamId, name: teamId, key: teamId })),
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
    isAuthError.mockReturnValue(false)
    getClients.mockReturnValue([makeEntry()])
  })

  it('surfaces Linear credential decrypt errors on active project metadata reads', async () => {
    const error = new Error(credentialDecryptionMessage('Linear'))
    getClients.mockImplementation(() => {
      throw error
    })
    const { listProjects } = await import('./projects')

    await expect(listProjects(undefined, 20, 'workspace-1', true)).rejects.toThrow(error.message)
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

  it('loads project teams above Linear connection page size', async () => {
    rawRequest
      .mockResolvedValueOnce(
        projectTeamsConnectionResponse(
          Array.from({ length: 50 }, (_, index) => `TEAM-${index + 1}`),
          { hasNextPage: true, endCursor: 'team-cursor-50' }
        )
      )
      .mockResolvedValueOnce(projectTeamsConnectionResponse(['TEAM-51'], { hasNextPage: false }))
    const { listProjectTeams } = await import('./projects')

    const result = await listProjectTeams('project-1', 'workspace-1', true)

    expect(result).toHaveLength(51)
    expect(result.at(-1)).toMatchObject({ id: 'TEAM-51', key: 'TEAM-51' })
    expect(rawRequest.mock.calls[0]?.[1]).toMatchObject({ id: 'project-1', first: 50 })
    expect(rawRequest.mock.calls[0]?.[1]).not.toHaveProperty('after')
    expect(rawRequest.mock.calls[1]?.[1]).toMatchObject({
      id: 'project-1',
      first: 50,
      after: 'team-cursor-50'
    })
  })

  it('loads exact project name matches beyond the first search page', async () => {
    rawRequest
      .mockResolvedValueOnce(
        projectSearchConnectionResponse(
          Array.from({ length: 50 }, (_, index) =>
            rawProjectWithName(`project-${index + 1}`, `Other ${index + 1}`)
          ),
          { hasNextPage: true, endCursor: 'project-cursor-50' }
        )
      )
      .mockResolvedValueOnce(
        projectSearchConnectionResponse([
          rawProjectWithName('project-launch', 'Launch'),
          rawProjectWithName('project-launch-lower', 'launch')
        ])
      )
    const { listProjectsByExactName } = await import('./projects')

    const result = await listProjectsByExactName('Launch', 'workspace-1', true)

    expect(result).toMatchObject([
      { id: 'project-launch', name: 'Launch' },
      { id: 'project-launch-lower', name: 'launch' }
    ])
    expect(rawRequest).toHaveBeenCalledTimes(2)
    expect(rawRequest.mock.calls[0]?.[1]).toMatchObject({
      term: 'Launch',
      first: 50
    })
    expect(rawRequest.mock.calls[0]?.[1]).not.toHaveProperty('after')
    expect(rawRequest.mock.calls[1]?.[1]).toMatchObject({
      term: 'Launch',
      first: 50,
      after: 'project-cursor-50'
    })
  })

  it('creates a project with team metadata and maps the created project', async () => {
    rawRequest.mockResolvedValueOnce({
      data: {
        projectCreate: {
          success: true,
          project: {
            ...rawProject('project-1'),
            description: 'Summary',
            content: 'Brief',
            priority: 2,
            targetDate: '2026-08-01',
            teams: { nodes: [{ id: 'team-1', name: 'Team', key: 'TM' }] }
          }
        }
      }
    })
    const { createProject } = await import('./projects')

    const result = await createProject(
      {
        name: 'Roadmap',
        description: 'Summary',
        content: 'Brief',
        teamIds: ['team-1'],
        leadId: 'user-1',
        memberIds: ['user-1', 'user-2'],
        labelIds: ['label-1'],
        priority: 2,
        startDate: '2026-07-01',
        targetDate: '2026-08-01'
      },
      'workspace-1'
    )

    expect(result).toMatchObject({
      ok: true,
      project: {
        id: 'project-1',
        name: 'project-1',
        workspaceId: 'workspace-1',
        description: 'Summary',
        content: 'Brief',
        priority: 2,
        targetDate: '2026-08-01',
        teams: [{ id: 'team-1', name: 'Team', key: 'TM' }]
      }
    })
    expect(rawRequest.mock.calls[0]?.[1]).toEqual({
      input: {
        name: 'Roadmap',
        description: 'Summary',
        content: 'Brief',
        teamIds: ['team-1'],
        leadId: 'user-1',
        memberIds: ['user-1', 'user-2'],
        labelIds: ['label-1'],
        priority: 2,
        startDate: '2026-07-01',
        targetDate: '2026-08-01'
      }
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

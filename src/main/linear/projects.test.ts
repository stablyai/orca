import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LinearClientForWorkspace } from './client'
import { credentialDecryptionMessage } from '../../shared/integration-credential-errors'

const rawRequest = vi.fn()
const getClients = vi.fn()
const clearToken = vi.fn()
const isAuthError = vi.fn()
const acquire = vi.fn().mockResolvedValue(undefined)
const release = vi.fn()

vi.mock('./linear-request-concurrency', () => ({
  acquire: (...args: unknown[]) => acquire(...args),
  release: (...args: unknown[]) => release(...args)
}))

vi.mock('./linear-token-store', () => ({
  clearToken: (...args: unknown[]) => clearToken(...args)
}))

vi.mock('./client', () => ({
  createSignalBoundLinearClient: (entry: LinearClientForWorkspace) => entry.client,
  getClients: (...args: unknown[]) => getClients(...args),
  isAuthError: (...args: unknown[]) => isAuthError(...args)
}))

function makeEntry(options?: {
  workspaceId?: string
  organizationName?: string
  request?: typeof rawRequest
}): LinearClientForWorkspace {
  return {
    workspace: {
      id: options?.workspaceId ?? 'workspace-1',
      organizationId: options?.workspaceId ?? 'workspace-1',
      organizationName: options?.organizationName ?? 'Workspace',
      displayName: 'Ada',
      email: 'ada@example.com'
    },
    client: {
      client: { rawRequest: options?.request ?? rawRequest }
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

function projectConnectionResponse(
  projects: ReturnType<typeof rawProject>[],
  pageInfo: { hasNextPage: boolean; endCursor?: string | null } = { hasNextPage: false }
) {
  return { data: { projects: { nodes: projects, pageInfo } } }
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

  it('walks every project page when the caller omits a limit', async () => {
    rawRequest.mockImplementation((_query, variables) =>
      Promise.resolve(
        variables.after
          ? projectConnectionResponse(
              Array.from({ length: 25 }, (_, index) => rawProject(`project-${index + 51}`)),
              { hasNextPage: false }
            )
          : projectConnectionResponse(
              Array.from({ length: 50 }, (_, index) => rawProject(`project-${index + 1}`)),
              { hasNextPage: true, endCursor: 'project-cursor-50' }
            )
      )
    )
    const { listProjects } = await import('./projects')

    const result = await listProjects(undefined, null, 'workspace-1', true)

    expect(result.items).toHaveLength(75)
    expect(result.hasMore).toBe(false)
    expect(rawRequest).toHaveBeenCalledTimes(2)
    expect(acquire).toHaveBeenCalledTimes(2)
    expect(release).toHaveBeenCalledTimes(2)
    expect(rawRequest.mock.calls[0][0]).toContain('$after: String')
    expect(rawRequest.mock.calls[0][0]).toContain('endCursor')
    expect(rawRequest.mock.calls[1][1]).toMatchObject({
      first: 50,
      after: 'project-cursor-50',
      orderBy: 'updatedAt'
    })
  })

  it('preserves explicit project limits above the legacy clamp', async () => {
    rawRequest.mockImplementation((_query, variables) =>
      Promise.resolve(
        variables.after
          ? projectConnectionResponse(
              Array.from({ length: 10 }, (_, index) => rawProject(`project-${index + 51}`)),
              { hasNextPage: true, endCursor: 'project-cursor-more' }
            )
          : projectConnectionResponse(
              Array.from({ length: 50 }, (_, index) => rawProject(`project-${index + 1}`)),
              { hasNextPage: true, endCursor: 'project-cursor-50' }
            )
      )
    )
    const { listProjects } = await import('./projects')

    const result = await listProjects(undefined, 60, 'workspace-1', true)

    expect(result.items).toHaveLength(60)
    expect(result.hasMore).toBe(true)
    expect(rawRequest.mock.calls[1][1]).toMatchObject({ first: 10 })
  })

  it('stops an exhaustive project walk at the page ceiling', async () => {
    let page = 0
    rawRequest.mockImplementation(() => {
      page += 1
      return Promise.resolve(
        projectConnectionResponse([rawProject(`project-${page}`)], {
          hasNextPage: true,
          endCursor: `project-cursor-${page}`
        })
      )
    })
    const { listProjects } = await import('./projects')

    const result = await listProjects(undefined, null, 'workspace-1', true)

    expect(result.items).toHaveLength(200)
    expect(result.hasMore).toBe(true)
    expect(rawRequest).toHaveBeenCalledTimes(200)
  })

  it('fairly exhausts every workspace when the project limit is omitted', async () => {
    const firstRequest = vi.fn()
    const secondRequest = vi.fn()
    for (const [prefix, request] of [
      ['W1', firstRequest],
      ['W2', secondRequest]
    ] as const) {
      let page = 0
      request.mockImplementation(() => {
        page += 1
        return Promise.resolve(
          projectConnectionResponse(
            [rawProject(`${prefix}-${page}`)],
            page === 1
              ? { hasNextPage: true, endCursor: `${prefix}-cursor-1` }
              : { hasNextPage: false }
          )
        )
      })
    }
    getClients.mockReturnValue([
      makeEntry({ request: firstRequest }),
      makeEntry({
        workspaceId: 'workspace-2',
        organizationName: 'Second Workspace',
        request: secondRequest
      })
    ])
    const { listProjects } = await import('./projects')

    const result = await listProjects(undefined, null, 'all', true)

    expect(result.items).toHaveLength(4)
    expect(result.hasMore).toBe(false)
    expect(firstRequest).toHaveBeenCalledTimes(2)
    expect(secondRequest).toHaveBeenCalledTimes(2)
  })

  it('retains all-workspace project rows when a later page fails', async () => {
    const firstRequest = vi
      .fn()
      .mockResolvedValueOnce(
        projectConnectionResponse([rawProject('W1-1')], {
          hasNextPage: true,
          endCursor: 'workspace-1-cursor-1'
        })
      )
      .mockRejectedValueOnce(new Error('fetch failed'))
    const secondRequest = vi
      .fn()
      .mockResolvedValueOnce(projectConnectionResponse([rawProject('W2-1')]))
    getClients.mockReturnValue([
      makeEntry({ request: firstRequest }),
      makeEntry({
        workspaceId: 'workspace-2',
        organizationName: 'Second Workspace',
        request: secondRequest
      })
    ])
    const { listProjects } = await import('./projects')

    const result = await listProjects(undefined, null, 'all', true)

    expect(result.items.map((project) => project.id)).toEqual(['W1-1', 'W2-1'])
    expect(result.hasMore).toBe(true)
    expect(result.errors).toMatchObject([
      { workspaceId: 'workspace-1', type: 'unknown', message: 'fetch failed' }
    ])
  })

  it('still rejects concrete project lists when a later page fails', async () => {
    rawRequest
      .mockResolvedValueOnce(
        projectConnectionResponse([rawProject('project-1')], {
          hasNextPage: true,
          endCursor: 'project-cursor-1'
        })
      )
      .mockRejectedValueOnce(new Error('fetch failed'))
    const { listProjects } = await import('./projects')

    await expect(listProjects(undefined, null, 'workspace-1', true)).rejects.toThrow('fetch failed')
  })

  it('deduplicates project pages and stops a nonconsecutive cursor cycle', async () => {
    rawRequest
      .mockResolvedValueOnce(
        projectConnectionResponse([rawProject('project-1')], {
          hasNextPage: true,
          endCursor: 'cursor-a'
        })
      )
      .mockResolvedValueOnce(
        projectConnectionResponse([rawProject('project-1'), rawProject('project-2')], {
          hasNextPage: true,
          endCursor: 'cursor-b'
        })
      )
      .mockResolvedValueOnce(
        projectConnectionResponse([rawProject('project-3')], {
          hasNextPage: true,
          endCursor: 'cursor-a'
        })
      )
    const { listProjects } = await import('./projects')

    const result = await listProjects(undefined, null, 'workspace-1', true)

    expect(result.items.map((project) => project.id)).toEqual([
      'project-1',
      'project-2',
      'project-3'
    ])
    expect(result.hasMore).toBe(true)
    expect(rawRequest).toHaveBeenCalledTimes(3)
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
    expect(rawRequest.mock.calls[0]?.[0]).toContain('mutation OrcaLinearProjectCreate')
    expect(rawRequest.mock.calls[0]?.[0]).toContain('projectCreate(input: $input)')
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

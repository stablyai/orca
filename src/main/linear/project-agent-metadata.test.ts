import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LinearClientForWorkspace } from './client'
import type { LinearProjectMetadataRequest } from './project-agent-metadata'

const rawRequestAcme = vi.fn()
const rawRequestGlobex = vi.fn()
const getClients = vi.fn()
const getStatus = vi.fn()

vi.mock('./linear-request-concurrency', () => ({
  acquire: vi.fn().mockResolvedValue(undefined),
  release: vi.fn()
}))

vi.mock('./linear-token-store', () => ({
  clearToken: vi.fn()
}))

vi.mock('./client', () => ({
  getClients: (...args: unknown[]) => getClients(...args),
  getStatus: () => getStatus(),
  isAuthError: vi.fn().mockReturnValue(false)
}))

function entry(id: string, name: string, rawRequest: unknown): LinearClientForWorkspace {
  return {
    workspace: {
      id,
      organizationId: id,
      organizationName: name,
      displayName: 'Ada',
      email: 'ada@example.com'
    },
    apiKey: 'key',
    client: { client: { rawRequest } }
  } as unknown as LinearClientForWorkspace
}

const acme = entry('workspace-acme', 'Acme', rawRequestAcme)
const globex = entry('workspace-globex', 'Globex', rawRequestGlobex)

const workspaces = [
  { id: 'workspace-acme', organizationId: 'workspace-acme', organizationName: 'Acme' },
  { id: 'workspace-globex', organizationId: 'workspace-globex', organizationName: 'Globex' }
]

function statusResponse(nodes: Record<string, unknown>[]): unknown {
  return { data: { organization: { projectStatuses: nodes } } }
}

function labelResponse(
  nodes: Record<string, unknown>[],
  pageInfo?: { hasNextPage: boolean; endCursor?: string }
): unknown {
  return {
    data: {
      organization: {
        projectLabels: {
          nodes,
          pageInfo: pageInfo ?? { hasNextPage: false, endCursor: null }
        }
      }
    }
  }
}

function labelNode(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'label-1',
    name: 'Infra',
    color: '#abcdef',
    isGroup: false,
    archivedAt: null,
    retiredAt: null,
    retiredBy: null,
    parent: null,
    ...overrides
  }
}

async function listStatuses(request: LinearProjectMetadataRequest) {
  const { listProjectStatusesForAgent } = await import('./project-agent-metadata')
  return await listProjectStatusesForAgent(request)
}

async function listLabels(request: LinearProjectMetadataRequest) {
  const { listProjectLabelsForAgent } = await import('./project-agent-metadata')
  return await listProjectLabelsForAgent(request)
}

describe('Linear project metadata discovery', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getStatus.mockReturnValue({ workspaces })
    getClients.mockImplementation((selection?: string) =>
      selection === 'all'
        ? [acme, globex]
        : [acme, globex].filter((client) => client.workspace.id === (selection ?? 'workspace-acme'))
    )
  })

  it('reads the unpaginated workspace status array and filters locally', async () => {
    rawRequestAcme.mockResolvedValueOnce(
      statusResponse([
        { id: 'status-1', name: 'In progress', type: 'started', color: '#0f0', archivedAt: null },
        { id: 'status-2', name: 'Paused', type: 'paused', color: '#ff0', archivedAt: null },
        { id: 'status-3', name: 'Progress (old)', type: 'planned', color: '#00f', archivedAt: '1' }
      ])
    )

    const result = await listStatuses({ query: 'progress', limit: 20 })

    const document = rawRequestAcme.mock.calls[0][0] as string
    expect(document).toContain('organization')
    expect(document).toContain('projectStatuses {')
    expect(document).not.toContain('first:')
    expect(result.statuses).toEqual([
      {
        id: 'status-1',
        name: 'In progress',
        type: 'started',
        color: '#0f0',
        workspaceId: 'workspace-acme',
        workspaceName: 'Acme'
      }
    ])
    expect(result.meta).toMatchObject({
      query: 'progress',
      limit: 20,
      returned: 1,
      partial: false,
      workspaceResults: [
        { workspace: { id: 'workspace-acme', name: 'Acme' }, returned: 1, hasMore: false }
      ],
      workspaceErrors: []
    })
  })

  it('marks a workspace as having more when the global cap drops its rows', async () => {
    rawRequestAcme.mockResolvedValueOnce(
      statusResponse([
        { id: 'status-1', name: 'Alpha', type: 'planned', color: '#0f0', archivedAt: null },
        { id: 'status-2', name: 'Beta', type: 'started', color: '#0f0', archivedAt: null }
      ])
    )

    const result = await listStatuses({ limit: 1 })

    expect(result.statuses.map((status) => status.name)).toEqual(['Alpha'])
    expect(result.meta.workspaceResults[0]).toMatchObject({ returned: 1, hasMore: true })
  })

  it('excludes archived, retired and group labels while keeping parent context', async () => {
    rawRequestAcme.mockResolvedValueOnce(
      labelResponse([
        labelNode({ parent: { id: 'group-1', name: 'Area' } }),
        labelNode({ id: 'label-2', name: 'Archived', archivedAt: '2026-01-01T00:00:00.000Z' }),
        labelNode({ id: 'label-3', name: 'Retired', retiredAt: '2026-01-01T00:00:00.000Z' }),
        labelNode({ id: 'label-4', name: 'RetiredBy', retiredBy: { id: 'user-1' } }),
        labelNode({ id: 'label-5', name: 'Group', isGroup: true })
      ])
    )

    const result = await listLabels({ query: 'in', limit: 20 })

    expect(rawRequestAcme.mock.calls[0][1]).toEqual({
      first: 50,
      filter: { isGroup: { eq: false }, name: { containsIgnoreCase: 'in' } }
    })
    expect(rawRequestAcme.mock.calls[0][0]).toContain('orderBy: createdAt')
    expect(result.labels).toEqual([
      {
        id: 'label-1',
        name: 'Infra',
        color: '#abcdef',
        parent: { id: 'group-1', name: 'Area' },
        workspaceId: 'workspace-acme',
        workspaceName: 'Acme'
      }
    ])
  })

  it('stops label discovery at the per-workspace scan cap and reports hasMore', async () => {
    const page = (start: number, cursor: string) =>
      labelResponse(
        Array.from({ length: 50 }, (_, index) =>
          labelNode({ id: `label-${start + index}`, name: `Label ${start + index}` })
        ),
        { hasNextPage: true, endCursor: cursor }
      )
    rawRequestAcme
      .mockResolvedValueOnce(page(0, 'c1'))
      .mockResolvedValueOnce(page(50, 'c2'))
      .mockResolvedValueOnce(page(100, 'c3'))
      .mockResolvedValueOnce(page(150, 'c4'))

    const result = await listLabels({ limit: 50 })

    expect(rawRequestAcme).toHaveBeenCalledTimes(4)
    expect(result.labels).toHaveLength(50)
    expect(result.meta.workspaceResults[0]).toMatchObject({ returned: 50, hasMore: true })
  })

  it('reports partial workspace failures under --workspace all without dropping rows', async () => {
    rawRequestAcme.mockResolvedValueOnce(
      statusResponse([
        { id: 'status-1', name: 'Alpha', type: 'planned', color: '#0f0', archivedAt: null }
      ])
    )
    rawRequestGlobex.mockRejectedValueOnce(new Error('fetch failed'))

    const result = await listStatuses({ limit: 20, workspaceId: 'all' })

    expect(result.statuses.map((status) => status.id)).toEqual(['status-1'])
    expect(result.meta.partial).toBe(true)
    expect(result.meta.workspaceErrors).toEqual([
      {
        workspace: { id: 'workspace-globex', name: 'Globex' },
        code: 'linear_network_error',
        message: 'fetch failed'
      }
    ])
    expect(result.meta.workspaceResults).toEqual([
      { workspace: { id: 'workspace-acme', name: 'Acme' }, returned: 1, hasMore: false }
    ])
  })

  it('fails the whole read when a single selected workspace fails', async () => {
    rawRequestGlobex.mockRejectedValueOnce(new Error('fetch failed'))

    await expect(
      listStatuses({ limit: 20, workspaceId: 'workspace-globex' })
    ).rejects.toMatchObject({ code: 'linear_network_error' })
  })

  it('sorts rows across workspaces by workspace name, then name, then id', async () => {
    rawRequestAcme.mockResolvedValueOnce(
      statusResponse([
        { id: 'status-2', name: 'Beta', type: 'planned', color: '#0f0', archivedAt: null }
      ])
    )
    rawRequestGlobex.mockResolvedValueOnce(
      statusResponse([
        { id: 'status-1', name: 'Alpha', type: 'planned', color: '#0f0', archivedAt: null }
      ])
    )

    const result = await listStatuses({ limit: 20, workspaceId: 'all' })

    expect(result.statuses.map((status) => status.workspaceName)).toEqual(['Acme', 'Globex'])
    expect(result.meta.workspaceId).toBe('all')
  })

  it('rejects an unknown workspace before any request', async () => {
    await expect(listLabels({ limit: 20, workspaceId: 'workspace-nope' })).rejects.toMatchObject({
      code: 'linear_invalid_workspace'
    })
    expect(rawRequestAcme).not.toHaveBeenCalled()
  })
})

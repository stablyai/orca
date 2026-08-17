import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LinearClientForWorkspace } from './client'

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

function teamResponse(nodes: Record<string, unknown>[]): unknown {
  return {
    data: {
      byKey: { nodes, pageInfo: { hasNextPage: false } },
      byName: { nodes: [], pageInfo: { hasNextPage: false } }
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

describe('Linear project write reference resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getStatus.mockReturnValue({ workspaces })
    getClients.mockImplementation((selection?: string) =>
      [acme, globex].filter((client) => client.workspace.id === selection)
    )
  })

  it('resolves an exact project status and excludes archived candidates', async () => {
    rawRequestAcme.mockResolvedValueOnce(
      statusResponse([
        { id: 'status-1', name: 'In progress', type: 'started', color: '#0f0', archivedAt: null },
        { id: 'status-2', name: 'In progress', type: 'planned', color: '#0f0', archivedAt: '1' }
      ])
    )
    const { resolveProjectStatusForWrite } = await import('./project-write-references')

    await expect(resolveProjectStatusForWrite('in PROGRESS', 'workspace-acme')).resolves.toEqual({
      id: 'status-1',
      name: 'In progress',
      type: 'started',
      color: '#0f0'
    })
  })

  it('fails an ambiguous status with candidates', async () => {
    rawRequestAcme.mockResolvedValueOnce(
      statusResponse([
        { id: 'status-1', name: 'Paused', type: 'paused', color: '#0f0', archivedAt: null },
        { id: 'status-2', name: 'paused', type: 'planned', color: '#0f0', archivedAt: null }
      ])
    )
    const { resolveProjectStatusForWrite } = await import('./project-write-references')

    await expect(resolveProjectStatusForWrite('Paused', 'workspace-acme')).rejects.toMatchObject({
      code: 'linear_invalid_state',
      data: { statuses: [{ id: 'status-1' }, { id: 'status-2' }] }
    })
  })

  it('pages label write resolution past the discovery scan cap', async () => {
    // Four full pages of unusable rows exhaust the 200-node discovery cap; the
    // match only appears on the fifth page.
    for (let page = 0; page < 4; page += 1) {
      rawRequestAcme.mockResolvedValueOnce(
        labelResponse(
          Array.from({ length: 50 }, (_, index) =>
            labelNode({ id: `group-${page}-${index}`, name: 'Infra', isGroup: true })
          ),
          { hasNextPage: true, endCursor: `c${page}` }
        )
      )
    }
    rawRequestAcme.mockResolvedValueOnce(
      labelResponse([labelNode({ id: 'label-9', name: 'Infra' })], { hasNextPage: false })
    )
    const { resolveProjectLabelsForWrite } = await import('./project-write-references')

    await expect(
      resolveProjectLabelsForWrite(['Infra', 'infra'], 'workspace-acme')
    ).resolves.toEqual([{ id: 'label-9', name: 'Infra', color: '#abcdef', parent: null }])
    expect(rawRequestAcme.mock.calls[0][1]).toMatchObject({
      first: 50,
      filter: { name: { eqIgnoreCase: 'Infra' } }
    })
    expect(rawRequestAcme).toHaveBeenCalledTimes(5)
  })

  it('resolves labels, dedupes inputs and rejects group labels', async () => {
    rawRequestAcme.mockResolvedValueOnce(labelResponse([labelNode()]))
    const { resolveProjectLabelsForWrite } = await import('./project-write-references')

    await expect(
      resolveProjectLabelsForWrite(['Infra', ' infra '], 'workspace-acme')
    ).resolves.toEqual([{ id: 'label-1', name: 'Infra', color: '#abcdef', parent: null }])

    rawRequestAcme.mockResolvedValueOnce(labelResponse([labelNode({ isGroup: true })]))
    await expect(resolveProjectLabelsForWrite(['Infra'], 'workspace-acme')).rejects.toMatchObject({
      code: 'linear_invalid_label',
      message: 'Linear project label "Infra" is a label group and cannot be applied.'
    })
  })

  it('rejects two children of the same exclusive label group', async () => {
    rawRequestAcme
      .mockResolvedValueOnce(
        labelResponse([labelNode({ id: 'label-1', parent: { id: 'group-1', name: 'Area' } })])
      )
      .mockResolvedValueOnce(
        labelResponse([
          labelNode({ id: 'label-2', name: 'Platform', parent: { id: 'group-1', name: 'Area' } })
        ])
      )
    const { resolveProjectLabelsForWrite } = await import('./project-write-references')

    await expect(
      resolveProjectLabelsForWrite(['Infra', 'Platform'], 'workspace-acme')
    ).rejects.toMatchObject({ code: 'linear_invalid_label' })
  })

  it('resolves an active workspace user by display name and rejects ambiguity', async () => {
    rawRequestAcme.mockResolvedValueOnce({
      data: {
        users: {
          nodes: [{ id: 'user-1', displayName: 'Ada', avatarUrl: null }],
          pageInfo: { hasNextPage: false }
        }
      }
    })
    const { resolveWorkspaceUserForWrite } = await import('./project-write-actors')

    await expect(resolveWorkspaceUserForWrite('Ada', 'workspace-acme')).resolves.toEqual({
      id: 'user-1',
      displayName: 'Ada',
      avatarUrl: null
    })
    expect(rawRequestAcme.mock.calls[0][1]).toEqual({
      filter: { active: { eq: true }, displayName: { eqIgnoreCase: 'Ada' } }
    })

    rawRequestAcme.mockResolvedValueOnce({
      data: { users: { nodes: [], pageInfo: { hasNextPage: false } } }
    })
    await expect(
      resolveWorkspaceUserForWrite('ada@example.com', 'workspace-acme')
    ).rejects.toMatchObject({ code: 'linear_invalid_assignee' })
    expect(rawRequestAcme.mock.calls[1][1]).toEqual({
      filter: { active: { eq: true }, email: { eqIgnoreCase: 'ada@example.com' } }
    })
  })

  it('resolves teams by key or exact name and dedupes repeated inputs', async () => {
    const teamResponse = {
      data: {
        byKey: {
          nodes: [{ id: 'team-1', name: 'Core', key: 'CORE' }],
          pageInfo: { hasNextPage: false }
        },
        byName: { nodes: [], pageInfo: { hasNextPage: false } }
      }
    }
    rawRequestAcme.mockResolvedValueOnce(teamResponse).mockResolvedValueOnce(teamResponse)
    const { resolveWorkspaceTeamsForWrite } = await import('./project-write-actors')

    await expect(
      resolveWorkspaceTeamsForWrite(['core', 'Core'], 'workspace-acme')
    ).resolves.toEqual([{ id: 'team-1', name: 'Core', key: 'CORE' }])
  })

  it('resolves a team by id with an id filter instead of key/name comparators', async () => {
    const teamId = '22222222-2222-4222-8222-222222222222'
    rawRequestAcme.mockResolvedValueOnce(teamResponse([{ id: teamId, name: 'Core', key: 'CORE' }]))
    const { resolveWorkspaceTeamsForWrite } = await import('./project-write-actors')

    await expect(resolveWorkspaceTeamsForWrite([teamId], 'workspace-acme')).resolves.toEqual([
      { id: teamId, name: 'Core', key: 'CORE' }
    ])
    expect(String(rawRequestAcme.mock.calls[0][0])).toContain('id: { eq: $term }')
    expect(rawRequestAcme.mock.calls[0][1]).toEqual({ term: teamId })
  })

  it('refuses to assign an archived team', async () => {
    rawRequestAcme.mockResolvedValueOnce(
      teamResponse([{ id: 'team-1', name: 'Core', key: 'CORE', archivedAt: '2026-01-01' }])
    )
    const { resolveWorkspaceTeamsForWrite } = await import('./project-write-actors')

    await expect(resolveWorkspaceTeamsForWrite(['CORE'], 'workspace-acme')).rejects.toMatchObject({
      code: 'linear_team_required'
    })
    expect(String(rawRequestAcme.mock.calls[0][0])).toContain('includeArchived: false')
  })

  it('refuses to assign an archived workspace user', async () => {
    rawRequestAcme.mockResolvedValueOnce({
      data: {
        users: {
          nodes: [{ id: 'user-1', displayName: 'Ada', avatarUrl: null, archivedAt: '2026-01-01' }],
          pageInfo: { hasNextPage: false }
        }
      }
    })
    const { resolveWorkspaceUserForWrite } = await import('./project-write-actors')

    await expect(resolveWorkspaceUserForWrite('Ada', 'workspace-acme')).rejects.toMatchObject({
      code: 'linear_invalid_assignee'
    })
    expect(String(rawRequestAcme.mock.calls[0][0])).toContain('includeDisabled: false')
  })

  it('picks the single connected workspace in which every team input resolves', async () => {
    rawRequestAcme.mockResolvedValueOnce(
      teamResponse([{ id: 'team-1', name: 'Core', key: 'CORE' }])
    )
    rawRequestGlobex.mockResolvedValueOnce(teamResponse([]))
    const { resolveProjectCreateScope } = await import('./project-create-workspace-scope')

    await expect(resolveProjectCreateScope(['CORE'], undefined)).resolves.toEqual({
      workspaceId: 'workspace-acme',
      workspaceName: 'Acme',
      teams: [{ id: 'team-1', name: 'Core', key: 'CORE' }]
    })
  })

  it('fails closed when two workspaces both resolve the team set', async () => {
    rawRequestAcme.mockResolvedValueOnce(
      teamResponse([{ id: 'team-1', name: 'Core', key: 'CORE' }])
    )
    rawRequestGlobex.mockResolvedValueOnce(
      teamResponse([{ id: 'team-2', name: 'Core', key: 'CORE' }])
    )
    const { resolveProjectCreateScope } = await import('./project-create-workspace-scope')

    await expect(resolveProjectCreateScope(['CORE'], undefined)).rejects.toMatchObject({
      code: 'linear_invalid_workspace',
      data: { candidates: [{ id: 'workspace-acme' }, { id: 'workspace-globex' }] }
    })
  })

  it('fails closed when no workspace resolves every team', async () => {
    rawRequestAcme.mockResolvedValueOnce(
      teamResponse([{ id: 'team-1', name: 'Core', key: 'CORE' }])
    )
    rawRequestAcme.mockResolvedValueOnce(teamResponse([]))
    rawRequestGlobex.mockResolvedValueOnce(teamResponse([]))
    const { resolveProjectCreateScope } = await import('./project-create-workspace-scope')

    await expect(resolveProjectCreateScope(['CORE', 'PLAT'], undefined)).rejects.toMatchObject({
      code: 'linear_team_required'
    })
  })

  it('propagates a workspace read failure instead of proving uniqueness from a partial fan-out', async () => {
    rawRequestAcme.mockResolvedValueOnce(
      teamResponse([{ id: 'team-1', name: 'Core', key: 'CORE' }])
    )
    rawRequestGlobex.mockRejectedValueOnce(new Error('fetch failed'))
    const { resolveProjectCreateScope } = await import('./project-create-workspace-scope')

    await expect(resolveProjectCreateScope(['CORE'], undefined)).rejects.toMatchObject({
      code: 'linear_network_error'
    })
  })

  it('confines create team resolution to an explicit workspace', async () => {
    rawRequestGlobex.mockResolvedValueOnce(
      teamResponse([{ id: 'team-2', name: 'Core', key: 'CORE' }])
    )
    const { resolveProjectCreateScope } = await import('./project-create-workspace-scope')

    await expect(resolveProjectCreateScope(['CORE'], 'workspace-globex')).resolves.toMatchObject({
      workspaceId: 'workspace-globex'
    })
    expect(rawRequestAcme).not.toHaveBeenCalled()
  })
})

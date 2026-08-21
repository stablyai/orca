import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LinearClientForWorkspace } from './client'
import type { LinearProjectCreateFields } from './project-create'

const rawRequest = vi.fn()
const createProject = vi.fn()
const getClients = vi.fn()
const clearToken = vi.fn()
const isAuthError = vi.fn()
const linearClientOptions: { apiKey?: string; signal?: AbortSignal }[] = []
const signalRawRequest = vi.fn()
const signalCreateProject = vi.fn()

vi.mock('./linear-request-concurrency', () => ({
  acquire: vi.fn().mockResolvedValue(undefined),
  release: vi.fn()
}))

vi.mock('./linear-token-store', () => ({
  clearToken: (...args: unknown[]) => clearToken(...args)
}))

vi.mock('./client', () => ({
  getClients: (...args: unknown[]) => getClients(...args),
  isAuthError: (...args: unknown[]) => isAuthError(...args)
}))

vi.mock('./linear-sdk', () => ({
  loadLinearSdk: () => ({
    AuthenticationLinearError: class extends Error {},
    LinearClient: class {
      client = { rawRequest: signalRawRequest }
      createProject = signalCreateProject
      constructor(options: { apiKey?: string; signal?: AbortSignal }) {
        linearClientOptions.push(options)
      }
    }
  })
}))

function entry(): LinearClientForWorkspace {
  return {
    apiKey: 'lin_api_key',
    workspace: {
      id: 'workspace-1',
      organizationId: 'workspace-1',
      organizationName: 'Acme',
      displayName: 'Ada',
      email: 'ada@example.com'
    },
    client: { createProject, client: { rawRequest } }
  } as unknown as LinearClientForWorkspace
}

const WRITE_ID = '11111111-1111-4111-8111-111111111111'

function fields(overrides: Partial<LinearProjectCreateFields> = {}): LinearProjectCreateFields {
  return { id: WRITE_ID, name: 'Importer', teamIds: ['team-1'], ...overrides }
}

function projectNode(overrides: Record<string, unknown> = {}) {
  return {
    id: 'project-1',
    name: 'Importer',
    slugId: 'importer-abc',
    url: 'https://linear.app/acme/project/importer-abc',
    description: '',
    content: null,
    color: '#5e6ad2',
    icon: null,
    priority: 0,
    startDate: null,
    targetDate: null,
    status: { id: 'status-1', name: 'In progress', type: 'started', color: '#0f0' },
    lead: null,
    members: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
    teams: {
      nodes: [{ id: 'team-1', name: 'Core', key: 'CORE' }],
      pageInfo: { hasNextPage: false, endCursor: null }
    },
    labels: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
    ...overrides
  }
}

function mutationOk(id = 'project-1') {
  return { success: true, projectId: id, project: Promise.resolve({ id }) }
}

describe('Linear project create', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    linearClientOptions.length = 0
    isAuthError.mockReturnValue(false)
    getClients.mockReturnValue([entry()])
  })

  it('pins the UUID v4 id, disables the default template and returns a confirmed record', async () => {
    createProject.mockResolvedValueOnce(mutationOk())
    rawRequest.mockResolvedValueOnce({ data: { project: projectNode() } })
    const { createProjectForAgent } = await import('./project-create')

    const record = await createProjectForAgent(fields(), 'workspace-1')

    expect(createProject).toHaveBeenCalledWith({
      id: WRITE_ID,
      name: 'Importer',
      teamIds: ['team-1'],
      useDefaultTemplate: false
    })
    expect(record.project).toEqual({
      id: 'project-1',
      name: 'Importer',
      slugId: 'importer-abc',
      url: 'https://linear.app/acme/project/importer-abc'
    })
    expect(record.fields).toMatchObject({
      name: 'Importer',
      description: '',
      content: null,
      teams: [{ id: 'team-1', name: 'Core', key: 'CORE' }]
    })
    expect(rawRequest.mock.calls[0]?.[1]).toEqual({ id: 'project-1' })
  })

  it('keeps priority 0 and empty description/content and normalizes prose line endings', async () => {
    createProject.mockResolvedValueOnce(mutationOk())
    rawRequest.mockResolvedValueOnce({ data: { project: projectNode() } })
    const { createProjectForAgent } = await import('./project-create')

    await createProjectForAgent(
      fields({
        priority: 0,
        description: '',
        content: 'line one\r\nline two\rline three',
        statusId: 'status-1',
        leadId: 'user-1',
        memberIds: ['user-1'],
        labelIds: ['label-1'],
        startDate: '2026-01-01',
        targetDate: '2026-02-01',
        color: '#5e6ad2'
      }),
      'workspace-1'
    )

    expect(createProject).toHaveBeenCalledWith({
      id: WRITE_ID,
      name: 'Importer',
      teamIds: ['team-1'],
      useDefaultTemplate: false,
      description: '',
      content: 'line one\nline two\nline three',
      statusId: 'status-1',
      leadId: 'user-1',
      memberIds: ['user-1'],
      labelIds: ['label-1'],
      priority: 0,
      startDate: '2026-01-01',
      targetDate: '2026-02-01',
      color: '#5e6ad2'
    })
  })

  it('requires a non-empty name and at least one team before any mutation', async () => {
    const { createProjectForAgent } = await import('./project-create')

    await expect(
      createProjectForAgent(fields({ name: '  ' }), 'workspace-1')
    ).rejects.toMatchObject({ kind: 'failed', name: 'LinearWriteFailure' })
    await expect(
      createProjectForAgent(fields({ teamIds: [] }), 'workspace-1')
    ).rejects.toMatchObject({ kind: 'failed' })
    expect(createProject).not.toHaveBeenCalled()
  })

  it('fails when the mutation reports success: false', async () => {
    createProject.mockResolvedValueOnce({ success: false, projectId: undefined })
    const { createProjectForAgent } = await import('./project-create')

    await expect(createProjectForAgent(fields(), 'workspace-1')).rejects.toMatchObject({
      kind: 'failed'
    })
    expect(rawRequest).not.toHaveBeenCalled()
  })

  it('treats a payload without a project and a read-back miss as unconfirmed', async () => {
    createProject.mockResolvedValueOnce({
      success: true,
      projectId: undefined,
      project: Promise.resolve(null)
    })
    const { createProjectForAgent } = await import('./project-create')

    await expect(createProjectForAgent(fields(), 'workspace-1')).rejects.toMatchObject({
      kind: 'unconfirmed'
    })

    createProject.mockResolvedValueOnce(mutationOk())
    rawRequest.mockResolvedValueOnce({ data: { project: null } })
    await expect(createProjectForAgent(fields(), 'workspace-1')).rejects.toMatchObject({
      kind: 'unconfirmed'
    })
  })

  it('treats a read-back transport failure as unconfirmed', async () => {
    createProject.mockResolvedValueOnce(mutationOk())
    rawRequest.mockRejectedValueOnce(new Error('fetch failed: socket hang up'))
    const { createProjectForAgent } = await import('./project-create')

    await expect(createProjectForAgent(fields(), 'workspace-1')).rejects.toMatchObject({
      kind: 'unconfirmed'
    })
  })

  it('surfaces a duplicate write id so the caller can compare create intent', async () => {
    createProject.mockRejectedValueOnce(new Error('id has already been used'))
    const { createProjectForAgent } = await import('./project-create')

    await expect(createProjectForAgent(fields(), 'workspace-1')).rejects.toMatchObject({
      kind: 'duplicate_id'
    })
  })

  it('reads back the complete snapshot, paging every connection past its first page', async () => {
    rawRequest
      .mockResolvedValueOnce({
        data: {
          project: projectNode({
            members: {
              nodes: [{ id: 'user-1', displayName: 'Ada', avatarUrl: null }],
              pageInfo: { hasNextPage: true, endCursor: 'c1' }
            }
          })
        }
      })
      .mockResolvedValueOnce({
        data: {
          project: {
            members: {
              nodes: [{ id: 'user-2', displayName: 'Grace', avatarUrl: null }],
              pageInfo: { hasNextPage: false, endCursor: 'c2' }
            }
          }
        }
      })
    const { getProjectByIdForAgent } = await import('./project-create')

    const record = await getProjectByIdForAgent('project-1', 'workspace-1')

    expect(record?.fields.members.map((member) => member.id)).toEqual(['user-1', 'user-2'])
    expect(rawRequest).toHaveBeenCalledTimes(2)
  })

  it('returns null for a true lookup miss and rethrows other lookup failures', async () => {
    rawRequest.mockRejectedValueOnce(
      new Error('Entity not found: Project - Could not find referenced Project.')
    )
    const { getProjectByIdForAgent } = await import('./project-create')

    await expect(getProjectByIdForAgent('project-1', 'workspace-1')).resolves.toBeNull()

    rawRequest.mockRejectedValueOnce(new Error('fetch failed: socket hang up'))
    await expect(getProjectByIdForAgent('project-1', 'workspace-1')).rejects.toThrow('fetch failed')
  })

  // Why: the pinned-id probe compares this snapshot against the create intent, so its
  // prose has to arrive LF-normalized rather than as Linear returned it.
  it('reads a pinned write id back as an LF-normalized snapshot', async () => {
    rawRequest.mockResolvedValue({
      data: {
        project: projectNode({
          // Why: ProjectCreateInput.id becomes the project id, so a pinned retry looks it up here.
          id: WRITE_ID,
          description: 'Overview\r\n',
          priority: 3,
          lead: { id: 'user-1', displayName: 'Ada', avatarUrl: null }
        })
      }
    })
    const { getProjectByIdForAgent } = await import('./project-create')

    const record = await getProjectByIdForAgent(WRITE_ID, 'workspace-1')

    expect(record?.project.id).toBe(WRITE_ID)
    expect(record?.fields.description).toBe('Overview\n')
    expect(record?.fields.priority).toBe(3)
    expect(record?.fields.lead?.id).toBe('user-1')
  })

  it('propagates the abort signal to the mutation and the read-back client', async () => {
    const controller = new AbortController()
    signalCreateProject.mockResolvedValueOnce(mutationOk())
    signalRawRequest.mockResolvedValueOnce({ data: { project: projectNode() } })
    const { createProjectForAgent } = await import('./project-create')

    await createProjectForAgent(fields(), 'workspace-1', { signal: controller.signal })

    expect(linearClientOptions).toEqual([{ apiKey: 'lin_api_key', signal: controller.signal }])
    expect(signalCreateProject).toHaveBeenCalledTimes(1)
    expect(signalRawRequest).toHaveBeenCalledTimes(1)
    expect(createProject).not.toHaveBeenCalled()
    expect(rawRequest).not.toHaveBeenCalled()
  })

  it('clears the token and rethrows when the workspace auth expired', async () => {
    createProject.mockRejectedValueOnce(new Error('authentication failed'))
    isAuthError.mockReturnValue(true)
    const { createProjectForAgent } = await import('./project-create')

    await expect(createProjectForAgent(fields(), 'workspace-1')).rejects.toThrow(
      'authentication failed'
    )
    expect(clearToken).toHaveBeenCalledWith('workspace-1')
  })

  it('fails closed when the workspace has no connected client', async () => {
    getClients.mockReturnValue([])
    const { createProjectForAgent, getProjectByIdForAgent } = await import('./project-create')

    await expect(createProjectForAgent(fields(), 'workspace-1')).rejects.toMatchObject({
      kind: 'failed'
    })
    await expect(getProjectByIdForAgent('project-1', 'workspace-1')).resolves.toBeNull()
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LinearClientForWorkspace } from './client'

const rawRequest = vi.fn()
const createProjectUpdate = vi.fn()
const getClients = vi.fn()
const clearToken = vi.fn()
const isAuthError = vi.fn()
const linearClientOptions: { apiKey?: string; signal?: AbortSignal }[] = []
const signalRawRequest = vi.fn()
const signalCreateProjectUpdate = vi.fn()

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
      createProjectUpdate = signalCreateProjectUpdate
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
    client: { createProjectUpdate, client: { rawRequest } }
  } as unknown as LinearClientForWorkspace
}

function updateNode(overrides: Record<string, unknown> = {}) {
  return {
    id: 'update-1',
    body: 'Shipped the importer.',
    health: 'atRisk',
    url: 'https://linear.app/acme/project/importer-abc/updates/update-1',
    isDiffHidden: true,
    isStale: false,
    createdAt: '2026-05-01T10:00:00.000Z',
    updatedAt: '2026-05-01T10:00:00.000Z',
    editedAt: null,
    project: { id: 'project-1' },
    user: { id: 'user-1', displayName: 'Ada', avatarUrl: null },
    ...overrides
  }
}

function mutationOk(id = 'update-1') {
  return { success: true, projectUpdate: Promise.resolve({ id }) }
}

const WRITE_ID = '11111111-1111-4111-8111-111111111111'

describe('Linear project update posts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    linearClientOptions.length = 0
    isAuthError.mockReturnValue(false)
    getClients.mockReturnValue([entry()])
  })

  it('passes the pinned id, health and hide-diff intent through verbatim', async () => {
    createProjectUpdate.mockResolvedValueOnce(mutationOk())
    rawRequest.mockResolvedValueOnce({ data: { projectUpdate: updateNode() } })
    const { addProjectUpdateForAgent } = await import('./project-update-posts')

    await expect(
      addProjectUpdateForAgent(
        'project-1',
        { body: 'Shipped the importer.', health: 'atRisk', isDiffHidden: true, id: WRITE_ID },
        'workspace-1'
      )
    ).resolves.toEqual({
      id: 'update-1',
      projectId: 'project-1',
      body: 'Shipped the importer.',
      health: 'atRisk',
      url: 'https://linear.app/acme/project/importer-abc/updates/update-1',
      isDiffHidden: true,
      isStale: false,
      createdAt: '2026-05-01T10:00:00.000Z',
      updatedAt: '2026-05-01T10:00:00.000Z',
      editedAt: null,
      user: { id: 'user-1', displayName: 'Ada', avatarUrl: null }
    })

    expect(createProjectUpdate).toHaveBeenCalledWith({
      id: WRITE_ID,
      projectId: 'project-1',
      body: 'Shipped the importer.',
      isDiffHidden: true,
      health: 'atRisk'
    })
    expect(rawRequest.mock.calls[0]?.[1]).toEqual({ id: 'update-1' })
  })

  it('sends isDiffHidden false explicitly and omits an unrequested health', async () => {
    createProjectUpdate.mockResolvedValueOnce(mutationOk())
    rawRequest.mockResolvedValueOnce({
      data: { projectUpdate: updateNode({ health: 'onTrack', isDiffHidden: false }) }
    })
    const { addProjectUpdateForAgent } = await import('./project-update-posts')

    await expect(
      addProjectUpdateForAgent(
        'project-1',
        { body: 'Weekly note.', isDiffHidden: false, id: WRITE_ID },
        'workspace-1'
      )
    ).resolves.toMatchObject({ health: 'onTrack', isDiffHidden: false })

    expect(createProjectUpdate).toHaveBeenCalledWith({
      id: WRITE_ID,
      projectId: 'project-1',
      body: 'Weekly note.',
      isDiffHidden: false
    })
    expect(createProjectUpdate.mock.calls[0]?.[0]).not.toHaveProperty('health')
  })

  it('normalizes CRLF and lone CR in the posted body without trimming prose', async () => {
    createProjectUpdate.mockResolvedValueOnce(mutationOk())
    rawRequest.mockResolvedValueOnce({
      data: { projectUpdate: updateNode({ body: '  line one\r\nline two\rline three  ' }) }
    })
    const { addProjectUpdateForAgent } = await import('./project-update-posts')

    const record = await addProjectUpdateForAgent(
      'project-1',
      { body: '  line one\r\nline two\rline three  ', isDiffHidden: false, id: WRITE_ID },
      'workspace-1'
    )

    expect(createProjectUpdate.mock.calls[0]?.[0]).toMatchObject({
      body: '  line one\nline two\nline three  '
    })
    expect(record.body).toBe('  line one\nline two\nline three  ')
  })

  it('fails when the mutation reports success: false', async () => {
    createProjectUpdate.mockResolvedValueOnce({ success: false, projectUpdate: undefined })
    const { addProjectUpdateForAgent } = await import('./project-update-posts')

    await expect(
      addProjectUpdateForAgent(
        'project-1',
        { body: 'Note.', isDiffHidden: false, id: WRITE_ID },
        'workspace-1'
      )
    ).rejects.toMatchObject({ kind: 'failed', name: 'LinearWriteFailure' })

    expect(rawRequest).not.toHaveBeenCalled()
  })

  it('treats a read-back miss as unconfirmed', async () => {
    createProjectUpdate.mockResolvedValueOnce(mutationOk())
    rawRequest.mockResolvedValueOnce({ data: { projectUpdate: null } })
    const { addProjectUpdateForAgent } = await import('./project-update-posts')

    await expect(
      addProjectUpdateForAgent(
        'project-1',
        { body: 'Note.', isDiffHidden: false, id: WRITE_ID },
        'workspace-1'
      )
    ).rejects.toMatchObject({ kind: 'unconfirmed' })
  })

  it('treats a read-back transport failure as unconfirmed', async () => {
    createProjectUpdate.mockResolvedValueOnce(mutationOk())
    rawRequest.mockRejectedValueOnce(new Error('fetch failed: socket hang up'))
    const { addProjectUpdateForAgent } = await import('./project-update-posts')

    await expect(
      addProjectUpdateForAgent(
        'project-1',
        { body: 'Note.', isDiffHidden: false, id: WRITE_ID },
        'workspace-1'
      )
    ).rejects.toMatchObject({ kind: 'unconfirmed' })
  })

  it('surfaces a duplicate write id so the caller can re-fetch and compare intent', async () => {
    createProjectUpdate.mockRejectedValueOnce(new Error('id has already been used'))
    const { addProjectUpdateForAgent } = await import('./project-update-posts')

    await expect(
      addProjectUpdateForAgent(
        'project-1',
        { body: 'Note.', isDiffHidden: false, id: WRITE_ID },
        'workspace-1'
      )
    ).rejects.toMatchObject({ kind: 'duplicate_id' })
  })

  it('returns every field a duplicate-id intent check needs', async () => {
    rawRequest.mockResolvedValueOnce({
      data: {
        projectUpdate: updateNode({
          project: { id: 'other-project' },
          body: 'A different note.\r\n',
          health: 'offTrack',
          isDiffHidden: false
        })
      }
    })
    const { getProjectUpdateById } = await import('./project-update-posts')

    // Why: a mismatch on any of these must stay visible to the caller rather
    // than collapsing into a false dedup.
    await expect(getProjectUpdateById(WRITE_ID, 'workspace-1')).resolves.toMatchObject({
      projectId: 'other-project',
      body: 'A different note.\n',
      health: 'offTrack',
      isDiffHidden: false
    })
  })

  it('returns null for a true lookup miss', async () => {
    rawRequest.mockRejectedValueOnce(
      new Error('Entity not found: ProjectUpdate - Could not find referenced ProjectUpdate.')
    )
    const { getProjectUpdateById } = await import('./project-update-posts')

    await expect(getProjectUpdateById(WRITE_ID, 'workspace-1')).resolves.toBeNull()
  })

  it('rethrows lookup failures that are not misses', async () => {
    rawRequest.mockRejectedValueOnce(new Error('fetch failed: socket hang up'))
    const { getProjectUpdateById } = await import('./project-update-posts')

    await expect(getProjectUpdateById(WRITE_ID, 'workspace-1')).rejects.toThrow('fetch failed')
  })

  it('treats a post without a resolvable project or author as a miss', async () => {
    rawRequest.mockResolvedValueOnce({ data: { projectUpdate: updateNode({ project: null }) } })
    const { getProjectUpdateById } = await import('./project-update-posts')

    await expect(getProjectUpdateById(WRITE_ID, 'workspace-1')).resolves.toBeNull()
  })

  it('propagates the abort signal to the mutation and the read-back client', async () => {
    const controller = new AbortController()
    signalCreateProjectUpdate.mockResolvedValueOnce(mutationOk())
    signalRawRequest.mockResolvedValueOnce({ data: { projectUpdate: updateNode() } })
    const { addProjectUpdateForAgent } = await import('./project-update-posts')

    await addProjectUpdateForAgent(
      'project-1',
      { body: 'Note.', isDiffHidden: true, id: WRITE_ID },
      'workspace-1',
      { signal: controller.signal }
    )

    expect(linearClientOptions).toEqual([{ apiKey: 'lin_api_key', signal: controller.signal }])
    expect(signalCreateProjectUpdate).toHaveBeenCalledTimes(1)
    expect(signalRawRequest).toHaveBeenCalledTimes(1)
    expect(createProjectUpdate).not.toHaveBeenCalled()
    expect(rawRequest).not.toHaveBeenCalled()
  })

  it('propagates the abort signal on lookups', async () => {
    const controller = new AbortController()
    signalRawRequest.mockResolvedValueOnce({ data: { projectUpdate: updateNode() } })
    const { getProjectUpdateById } = await import('./project-update-posts')

    await expect(
      getProjectUpdateById(WRITE_ID, 'workspace-1', { signal: controller.signal })
    ).resolves.toMatchObject({ id: 'update-1' })

    expect(linearClientOptions).toEqual([{ apiKey: 'lin_api_key', signal: controller.signal }])
    expect(rawRequest).not.toHaveBeenCalled()
  })

  it('clears the token and rethrows when the workspace auth expired', async () => {
    createProjectUpdate.mockRejectedValueOnce(new Error('authentication failed'))
    isAuthError.mockReturnValue(true)
    const { addProjectUpdateForAgent } = await import('./project-update-posts')

    await expect(
      addProjectUpdateForAgent(
        'project-1',
        { body: 'Note.', isDiffHidden: false, id: WRITE_ID },
        'workspace-1'
      )
    ).rejects.toThrow('authentication failed')
    expect(clearToken).toHaveBeenCalledWith('workspace-1')
  })

  it('fails closed when the workspace has no connected client', async () => {
    getClients.mockReturnValue([])
    const { addProjectUpdateForAgent, getProjectUpdateById } =
      await import('./project-update-posts')

    await expect(
      addProjectUpdateForAgent(
        'project-1',
        { body: 'Note.', isDiffHidden: false, id: WRITE_ID },
        'workspace-1'
      )
    ).rejects.toMatchObject({ kind: 'failed' })
    await expect(getProjectUpdateById(WRITE_ID, 'workspace-1')).resolves.toBeNull()
  })
})

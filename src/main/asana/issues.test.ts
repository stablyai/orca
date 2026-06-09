import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AsanaClientForWorkspace } from './client'

const { clearTokenMock, getClientsMock, asanaRequestMock } = vi.hoisted(() => ({
  clearTokenMock: vi.fn(),
  getClientsMock: vi.fn(),
  asanaRequestMock: vi.fn()
}))

class FakeAsanaApiError extends Error {
  status: number | null
  constructor(message: string, status: number | null = null) {
    super(message)
    this.status = status
  }
}

vi.mock('./client', () => ({
  acquire: vi.fn().mockResolvedValue(undefined),
  release: vi.fn(),
  clearToken: (...args: unknown[]) => clearTokenMock(...args),
  getClients: (...args: unknown[]) => getClientsMock(...args),
  isAuthError: (error: unknown) =>
    error instanceof FakeAsanaApiError && (error.status === 401 || error.status === 403),
  AsanaApiError: FakeAsanaApiError,
  asanaRequest: (...args: unknown[]) => asanaRequestMock(...args)
}))

function makeEntry(id = 'ws-1', name = 'Example Workspace'): AsanaClientForWorkspace {
  return {
    workspace: {
      id,
      name,
      userGid: 'user-1',
      userName: 'Ada',
      userEmail: 'ada@example.com'
    },
    authorization: 'Bearer token'
  }
}

describe('Asana task operations', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getClientsMock.mockReturnValue([makeEntry()])
  })

  it('lists assigned tasks with the incomplete-only filter and maps fields', async () => {
    asanaRequestMock.mockResolvedValueOnce({
      data: [
        {
          gid: '111',
          name: 'Ship onboarding',
          notes: 'Wire the empty state',
          permalink_url: 'https://app.asana.com/0/1/111',
          completed: false,
          due_on: '2026-06-30',
          assignee: { gid: 'user-1', name: 'Ada', email: 'ada@example.com' },
          projects: [{ gid: 'proj-1', name: 'Growth' }],
          created_at: '2026-06-01T00:00:00.000Z',
          modified_at: '2026-06-02T00:00:00.000Z',
          memberships: [{ section: { name: 'In progress' } }]
        }
      ]
    })

    const { listTasks } = await import('./issues')

    await expect(listTasks('assigned', 30, 'ws-1')).resolves.toEqual([
      {
        gid: '111',
        workspaceId: 'ws-1',
        workspaceName: 'Example Workspace',
        title: 'Ship onboarding',
        description: 'Wire the empty state',
        url: 'https://app.asana.com/0/1/111',
        completed: false,
        dueOn: '2026-06-30',
        assignee: { gid: 'user-1', name: 'Ada', email: 'ada@example.com' },
        projects: [
          { gid: 'proj-1', name: 'Growth', workspaceId: 'ws-1', workspaceName: 'Example Workspace' }
        ],
        section: 'In progress',
        createdAt: '2026-06-01T00:00:00.000Z',
        updatedAt: '2026-06-02T00:00:00.000Z'
      }
    ])

    const requestedPath = String(asanaRequestMock.mock.calls[0][1])
    expect(requestedPath).toContain('assignee=me')
    expect(requestedPath).toContain('workspace=ws-1')
    expect(requestedPath).toContain('completed_since=now')
  })

  it('filters to completed tasks for the done preset', async () => {
    asanaRequestMock.mockResolvedValueOnce({
      data: [
        { gid: '1', name: 'Open task', completed: false },
        { gid: '2', name: 'Closed task', completed: true }
      ]
    })

    const { listTasks } = await import('./issues')

    const tasks = await listTasks('done', 30, 'ws-1')
    expect(tasks.map((task) => task.gid)).toEqual(['2'])
    expect(String(asanaRequestMock.mock.calls[0][1])).not.toContain('completed_since')
  })

  it('creates a task scoped to a project when a project id is given', async () => {
    asanaRequestMock.mockResolvedValueOnce({
      data: { gid: '999', permalink_url: 'https://app.asana.com/0/1/999' }
    })

    const { createTask } = await import('./issues')

    await expect(
      createTask({ workspaceId: 'ws-1', projectId: 'proj-1', title: 'New task', notes: 'Body' })
    ).resolves.toEqual({ ok: true, gid: '999', url: 'https://app.asana.com/0/1/999' })

    const requestInit = asanaRequestMock.mock.calls[0][2] as { body: string }
    expect(JSON.parse(requestInit.body).data).toMatchObject({
      name: 'New task',
      notes: 'Body',
      projects: ['proj-1']
    })
  })

  it('toggles completion through updateTask', async () => {
    asanaRequestMock.mockResolvedValueOnce(null)

    const { updateTask } = await import('./issues')

    await expect(updateTask('111', { completed: true }, 'ws-1')).resolves.toEqual({ ok: true })

    const requestInit = asanaRequestMock.mock.calls[0][2] as { body: string; method: string }
    expect(requestInit.method).toBe('PUT')
    expect(JSON.parse(requestInit.body).data).toEqual({ completed: true })
  })

  it('returns only comment stories from the task feed', async () => {
    asanaRequestMock.mockResolvedValueOnce({
      data: [
        { gid: 's1', type: 'system', text: 'added to project' },
        {
          gid: 's2',
          type: 'comment',
          text: 'Looks good',
          created_at: '2026-06-03T00:00:00.000Z',
          created_by: { gid: 'user-2', name: 'Grace' }
        }
      ]
    })

    const { getTaskComments } = await import('./issues')

    await expect(getTaskComments('111', 'ws-1')).resolves.toEqual([
      {
        gid: 's2',
        text: 'Looks good',
        createdAt: '2026-06-03T00:00:00.000Z',
        user: { gid: 'user-2', name: 'Grace', email: undefined }
      }
    ])
  })

  it('sorts projects alphabetically across the workspace', async () => {
    asanaRequestMock.mockResolvedValueOnce({
      data: [
        { gid: '2', name: 'Bravo' },
        { gid: '1', name: 'Alpha' }
      ]
    })

    const { listProjects } = await import('./issues')

    await expect(listProjects('ws-1')).resolves.toEqual([
      { gid: '1', name: 'Alpha', workspaceId: 'ws-1', workspaceName: 'Example Workspace' },
      { gid: '2', name: 'Bravo', workspaceId: 'ws-1', workspaceName: 'Example Workspace' }
    ])
  })

  it('falls back to local title filtering when search is not available', async () => {
    asanaRequestMock
      .mockRejectedValueOnce(new FakeAsanaApiError('Payment Required', 402))
      .mockResolvedValueOnce({
        data: [
          { gid: '1', name: 'Fix login bug', completed: false },
          { gid: '2', name: 'Write docs', completed: false }
        ]
      })

    const { searchTasks } = await import('./issues')

    const tasks = await searchTasks('login', 30, 'ws-1')
    expect(tasks.map((task) => task.gid)).toEqual(['1'])
  })

  it('does not mask non-premium API errors with the local title filter', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // A 5xx (also 429/400) must NOT trigger the premium-only fallback, which would
    // return a plausible-but-wrong title-filtered slice of assigned tasks.
    asanaRequestMock.mockRejectedValueOnce(new FakeAsanaApiError('Internal Server Error', 500))

    const { searchTasks } = await import('./issues')

    // The error degrades to the contract-standard empty result + warning (same as
    // listTasks), never the fabricated local-filter list.
    await expect(searchTasks('login', 30, 'ws-1')).resolves.toEqual([])
    // The fallback fetch must not have been attempted — only the failed search call.
    expect(asanaRequestMock).toHaveBeenCalledTimes(1)
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('clears the token and propagates the auth error when a single workspace is selected', async () => {
    asanaRequestMock.mockRejectedValueOnce(new FakeAsanaApiError('Unauthorized', 401))

    const { listTasks } = await import('./issues')

    await expect(listTasks('assigned', 30, 'ws-1')).rejects.toMatchObject({ status: 401 })
    expect(clearTokenMock).toHaveBeenCalledWith('ws-1')
  })

  it('swallows one workspace auth error and still returns surviving tasks when selecting all', async () => {
    getClientsMock.mockReturnValue([makeEntry('ws-1', 'First'), makeEntry('ws-2', 'Second')])
    asanaRequestMock.mockImplementation((entry: AsanaClientForWorkspace) => {
      if (entry.workspace.id === 'ws-1') {
        return Promise.reject(new FakeAsanaApiError('Unauthorized', 401))
      }
      return Promise.resolve({ data: [{ gid: '2', name: 'Survivor', completed: false }] })
    })

    const { listTasks } = await import('./issues')

    const tasks = await listTasks('assigned', 30, 'all')
    expect(tasks.map((task) => task.gid)).toEqual(['2'])
    // The revoked workspace's token is cleared, but the error does not blank the aggregate.
    expect(clearTokenMock).toHaveBeenCalledWith('ws-1')
    expect(clearTokenMock).not.toHaveBeenCalledWith('ws-2')
  })

  it('merges and sorts tasks across workspaces by updatedAt descending when selecting all', async () => {
    getClientsMock.mockReturnValue([makeEntry('ws-1', 'First'), makeEntry('ws-2', 'Second')])
    asanaRequestMock.mockImplementation((entry: AsanaClientForWorkspace) => {
      if (entry.workspace.id === 'ws-1') {
        return Promise.resolve({
          data: [
            {
              gid: 'older',
              name: 'Older',
              completed: false,
              modified_at: '2026-06-01T00:00:00.000Z'
            }
          ]
        })
      }
      return Promise.resolve({
        data: [
          { gid: 'newer', name: 'Newer', completed: false, modified_at: '2026-06-05T00:00:00.000Z' }
        ]
      })
    })

    const { listTasks } = await import('./issues')

    const tasks = await listTasks('assigned', 30, 'all')
    // Cross-workspace results are sorted by recency, not by workspace fan-out order.
    expect(tasks.map((task) => task.gid)).toEqual(['newer', 'older'])
  })

  it('sorts a single workspace by updatedAt descending', async () => {
    getClientsMock.mockReturnValue([makeEntry('ws-1', 'First')])
    // Why: Asana's /tasks list has no server-side sort, so a single workspace
    // must still be ordered "recently updated first" to match GitHub/Jira.
    asanaRequestMock.mockResolvedValueOnce({
      data: [
        { gid: 'older', name: 'Older', completed: false, modified_at: '2026-06-01T00:00:00.000Z' },
        { gid: 'newer', name: 'Newer', completed: false, modified_at: '2026-06-05T00:00:00.000Z' }
      ]
    })

    const { listTasks } = await import('./issues')

    const tasks = await listTasks('assigned', 30, 'ws-1')
    expect(tasks.map((task) => task.gid)).toEqual(['newer', 'older'])
  })

  it('respects the limit when merging tasks across workspaces', async () => {
    getClientsMock.mockReturnValue([makeEntry('ws-1', 'First'), makeEntry('ws-2', 'Second')])
    asanaRequestMock.mockImplementation((entry: AsanaClientForWorkspace) => {
      const stamp =
        entry.workspace.id === 'ws-1' ? '2026-06-01T00:00:00.000Z' : '2026-06-05T00:00:00.000Z'
      return Promise.resolve({
        data: [
          { gid: `${entry.workspace.id}-a`, name: 'A', completed: false, modified_at: stamp },
          { gid: `${entry.workspace.id}-b`, name: 'B', completed: false, modified_at: stamp }
        ]
      })
    })

    const { listTasks } = await import('./issues')

    const tasks = await listTasks('assigned', 3, 'all')
    expect(tasks).toHaveLength(3)
  })
})

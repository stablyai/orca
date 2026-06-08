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

function makeEntry(): AsanaClientForWorkspace {
  return {
    workspace: {
      id: 'ws-1',
      name: 'Example Workspace',
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
})

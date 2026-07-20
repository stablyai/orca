import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClickUpClientForWorkspace } from './client'

const { clickUpRequestMock, getClientsMock, getStatusMock } = vi.hoisted(() => ({
  clickUpRequestMock: vi.fn(),
  getClientsMock: vi.fn(),
  getStatusMock: vi.fn()
}))

vi.mock('./client', () => ({
  ClickUpApiError: class ClickUpApiError extends Error {
    status: number | null
    constructor(message: string, status: number | null = null) {
      super(message)
      this.status = status
    }
  },
  clickUpRequest: (...args: unknown[]) => clickUpRequestMock(...args),
  getClients: (...args: unknown[]) => getClientsMock(...args),
  getStatus: (...args: unknown[]) => getStatusMock(...args),
  requireClickUpClient: (workspaceId?: string) => {
    const selected = getClientsMock(workspaceId)[0]
    if (!selected) {
      throw new Error('Connect ClickUp and select a Workspace first.')
    }
    return selected
  },
  requireClickUpClients: (workspaceId?: string) => {
    const selected = getClientsMock(workspaceId)
    if (selected.length === 0) {
      throw new Error('Connect ClickUp and select a Workspace first.')
    }
    return selected
  }
}))

function client(id = 'team-1'): ClickUpClientForWorkspace {
  return { workspace: { id, name: `Workspace ${id}` }, token: 'pk_token' }
}

function rawTask(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    custom_id: `ORC-${id}`,
    name: `Task ${id}`,
    url: `https://app.clickup.com/t/${id}`,
    status: { status: 'in progress', color: '#123456', type: 'custom', orderindex: 2 },
    priority: { id: '2', priority: 'high', color: '#ff0000', orderindex: '2' },
    assignees: [{ id: 7, username: 'Ada' }],
    creator: { id: 9, username: 'Grace' },
    tags: [{ name: 'bug', tag_fg: '#fff', tag_bg: '#000' }],
    list: { id: 'list-1', name: 'Backlog' },
    folder: { id: 'folder-1', name: 'Product' },
    space: { id: 'space-1', name: 'Engineering' },
    date_created: '1767225600000',
    date_updated: '1767312000000',
    due_date: '1769904000000',
    markdown_description: 'Task body',
    ...overrides
  }
}

describe('ClickUp task operations', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getClientsMock.mockReturnValue([client()])
    getStatusMock.mockReturnValue({ connected: true, viewer: { id: 7, username: 'Ada' } })
  })

  it('maps ClickUp task fields and scopes assigned listings to the viewer', async () => {
    clickUpRequestMock.mockResolvedValue({ tasks: [rawTask('abc')] })
    const { listTasks } = await import('./tasks')

    await expect(listTasks('assigned', 10, 'team-1')).resolves.toMatchObject([
      {
        id: 'abc',
        customId: 'ORC-abc',
        workspaceId: 'team-1',
        name: 'Task abc',
        description: 'Task body',
        status: { name: 'in progress', color: '#123456' },
        priority: { id: 2, name: 'high' },
        assignees: [{ id: 7, username: 'Ada' }],
        list: { id: 'list-1', name: 'Backlog' }
      }
    ])
    expect(String(clickUpRequestMock.mock.calls[0][1])).toContain('assignees%5B%5D=7')
  })

  it('searches task IDs, custom IDs, titles, and descriptions across pages', async () => {
    clickUpRequestMock.mockResolvedValueOnce({
      tasks: [rawTask('abc', { name: 'Authentication regression' })]
    })
    const { searchTasks } = await import('./tasks')

    await expect(searchTasks('authentication', 5, 'team-1')).resolves.toMatchObject([
      { id: 'abc', name: 'Authentication regression' }
    ])
  })

  it('continues listing after a full page contains no client-side filter matches', async () => {
    clickUpRequestMock
      .mockResolvedValueOnce({
        tasks: Array.from({ length: 100 }, (_, index) => rawTask(`other-${index}`))
      })
      .mockResolvedValueOnce({
        tasks: [rawTask('mine', { creator: { id: 7, username: 'Ada' } })]
      })
    const { listTasks } = await import('./tasks')

    await expect(listTasks('created', 10, 'team-1')).resolves.toMatchObject([{ id: 'mine' }])
    expect(clickUpRequestMock).toHaveBeenCalledTimes(2)
  })

  it('uses the raw page size when deciding whether search should continue', async () => {
    clickUpRequestMock
      .mockResolvedValueOnce({
        tasks: [
          {},
          ...Array.from({ length: 99 }, (_, index) =>
            rawTask(`other-${index}`, { name: `Unrelated ${index}` })
          )
        ]
      })
      .mockResolvedValueOnce({
        tasks: [rawTask('match', { name: 'Authentication regression' })]
      })
    const { searchTasks } = await import('./tasks')

    await expect(searchTasks('authentication', 5, 'team-1')).resolves.toMatchObject([
      { id: 'match' }
    ])
    expect(clickUpRequestMock).toHaveBeenCalledTimes(2)
  })

  it('uses the task response Workspace when an all-Workspace client reads it', async () => {
    getStatusMock.mockReturnValue({
      connected: true,
      viewer: { id: 7, username: 'Ada' },
      workspaces: [
        { id: 'team-1', name: 'First' },
        { id: 'team-2', name: 'Second' }
      ]
    })
    clickUpRequestMock.mockResolvedValue(rawTask('abc', { team_id: 'team-2' }))
    const { getTask } = await import('./tasks')

    await expect(getTask('abc')).resolves.toMatchObject({
      workspaceId: 'team-2',
      workspaceName: 'Second'
    })
  })

  it('sends ClickUp update deltas and tag mutations', async () => {
    clickUpRequestMock
      .mockResolvedValueOnce(rawTask('abc'))
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
    const { updateTask } = await import('./tasks')

    await expect(
      updateTask(
        'abc',
        { status: 'review', priority: 1, assigneeIds: [9], tagNames: ['security'] },
        'team-1'
      )
    ).resolves.toEqual({ ok: true })

    const updateCall = clickUpRequestMock.mock.calls.find(
      (call) => call[1] === '/task/abc' && call[2]?.method === 'PUT'
    )
    expect(JSON.parse(updateCall?.[2].body as string)).toEqual({
      status: 'review',
      priority: 1,
      assignees: { add: [9], rem: [7] }
    })
    expect(clickUpRequestMock).toHaveBeenCalledWith(expect.anything(), '/task/abc/tag/security', {
      method: 'POST'
    })
    expect(clickUpRequestMock).toHaveBeenCalledWith(expect.anything(), '/task/abc/tag/bug', {
      method: 'DELETE'
    })
  })

  it('reports each failed tag operation after attempting the full reconciliation', async () => {
    clickUpRequestMock
      .mockResolvedValueOnce(rawTask('abc'))
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error('remove failed'))
    const { updateTask } = await import('./tasks')

    await expect(updateTask('abc', { tagNames: ['security'] }, 'team-1')).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('remove "bug"')
    })
    expect(clickUpRequestMock).toHaveBeenCalledWith(expect.anything(), '/task/abc/tag/security', {
      method: 'POST'
    })
    expect(clickUpRequestMock).toHaveBeenCalledWith(expect.anything(), '/task/abc/tag/bug', {
      method: 'DELETE'
    })
  })

  it('walks Spaces, Folders, and folderless Lists for create destinations', async () => {
    clickUpRequestMock
      .mockResolvedValueOnce({ spaces: [{ id: 'space-1', name: 'Engineering' }] })
      .mockResolvedValueOnce({ folders: [{ id: 'folder-1', name: 'Product' }] })
      .mockResolvedValueOnce({ lists: [{ id: 'list-1', name: 'Inbox' }] })
      .mockResolvedValueOnce({ lists: [{ id: 'list-2', name: 'Backlog' }] })
    const { listLists } = await import('./tasks')

    await expect(listLists('team-1')).resolves.toMatchObject([
      { id: 'list-1', space: { name: 'Engineering' }, name: 'Inbox' },
      {
        id: 'list-2',
        space: { name: 'Engineering' },
        folder: { name: 'Product' },
        name: 'Backlog'
      }
    ])
  })
})

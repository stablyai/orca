import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClickUpClientForWorkspace } from './client'

const { clickUpRequestMock, getClientsMock, getStatusMock, readClickUpAccountMock } = vi.hoisted(
  () => ({
    clickUpRequestMock: vi.fn(),
    getClientsMock: vi.fn(),
    getStatusMock: vi.fn(),
    readClickUpAccountMock: vi.fn()
  })
)

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
  onClickUpDisconnect: vi.fn(),
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

vi.mock('./connection-storage', () => ({
  readClickUpAccount: (...args: unknown[]) => readClickUpAccountMock(...args)
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
    readClickUpAccountMock.mockReturnValue(null)
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

  it('uses the task response Workspace when an all-Workspace client reads it', async () => {
    readClickUpAccountMock.mockReturnValue({
      version: 1,
      viewer: { id: 7, username: 'Ada' },
      workspaces: [
        { id: 'team-1', name: 'First' },
        { id: 'team-2', name: 'Second' }
      ],
      activeWorkspaceId: 'team-1',
      selectedWorkspaceId: 'all'
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
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mocked request receives a JSON string body built by updateTask.
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

  it("reads a custom task id through ClickUp's custom_task_ids lookup", async () => {
    clickUpRequestMock.mockResolvedValue(rawTask('abc', { custom_id: 'CHP-7616' }))
    const { getTask } = await import('./tasks')

    await expect(getTask('CHP-7616', 'team-1')).resolves.toMatchObject({
      id: 'abc',
      customId: 'CHP-7616'
    })
    const path = String(clickUpRequestMock.mock.calls[0][1])
    expect(path).toContain('/task/CHP-7616?')
    expect(path).toContain('custom_task_ids=true')
    expect(path).toContain('team_id=team-1')
  })

  it('lists a whole Space past one page when scoped', async () => {
    clickUpRequestMock
      .mockResolvedValueOnce({
        tasks: Array.from({ length: 100 }, (_, index) => rawTask(`a${index}`))
      })
      .mockResolvedValueOnce({ tasks: [rawTask('last')] })
    const { listTasks } = await import('./tasks')

    const tasks = await listTasks('all', 500, 'team-1', { spaceId: '901', statuses: ['to do'] })

    expect(tasks).toHaveLength(101)
    const path = String(clickUpRequestMock.mock.calls[0][1])
    expect(path).toContain('space_ids%5B%5D=901')
    expect(path).toContain('statuses%5B%5D=to+do')
    expect(String(clickUpRequestMock.mock.calls[1][1])).toContain('page=1')
  })
})

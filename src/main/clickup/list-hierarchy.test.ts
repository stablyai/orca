import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClickUpClientForWorkspace } from './client'

const { clickUpRequestMock, getClientsMock } = vi.hoisted(() => ({
  clickUpRequestMock: vi.fn(),
  getClientsMock: vi.fn()
}))

vi.mock('./client', () => ({
  clickUpRequest: (...args: unknown[]) => clickUpRequestMock(...args),
  onClickUpDisconnect: vi.fn(),
  requireClickUpClient: (workspaceId?: string) => getClientsMock(workspaceId)[0],
  requireClickUpClients: (workspaceId?: string) => getClientsMock(workspaceId)
}))

function client(id = 'team-1'): ClickUpClientForWorkspace {
  return { workspace: { id, name: `Workspace ${id}` }, token: 'pk_token' }
}

function mockHierarchy(): void {
  clickUpRequestMock.mockImplementation(async (_client: unknown, path: string) => {
    if (path.startsWith('/team/')) {
      return {
        spaces: [
          {
            id: 'space-1',
            name: 'Engineering',
            statuses: [
              { status: 'to do', type: 'open', orderindex: 0 },
              { status: 'complete', type: 'closed', orderindex: 1 }
            ]
          },
          { id: 'space-2', name: 'Analytics' }
        ]
      }
    }
    if (path.startsWith('/space/space-1/folder')) {
      return {
        folders: [
          {
            id: 'folder-1',
            name: 'Product',
            lists: [
              {
                id: 'list-2',
                name: 'Backlog',
                statuses: [{ status: 'open', type: 'open' }],
                start_date: '1791763200000',
                due_date: '1792886400000',
                task_count: '66'
              },
              { id: 'list-3', name: 'Old', archived: true }
            ]
          },
          { id: 'folder-2', name: 'Archived', archived: true, lists: [{ id: 'x', name: 'X' }] }
        ]
      }
    }
    if (path.startsWith('/space/space-1/list')) {
      return { lists: [{ id: 'list-1', name: 'Inbox' }] }
    }
    if (path.startsWith('/space/space-2/')) {
      return path.includes('/folder')
        ? { folders: [] }
        : { lists: [{ id: 'analytics-list', name: 'Reports' }] }
    }
    if (path.startsWith('/list/list-9')) {
      return { id: 'list-9', name: 'Solo', space: { id: 'space-1', name: 'Engineering' } }
    }
    throw new Error(`unexpected ${path}`)
  })
}

describe('ClickUp List hierarchy', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    getClientsMock.mockReturnValue([client()])
    const { clearClickUpListCache } = await import('./list-hierarchy')
    clearClickUpListCache()
    mockHierarchy()
  })

  it('reads Folder Lists inline instead of one request per Folder', async () => {
    const { listClickUpLists } = await import('./list-hierarchy')

    await expect(listClickUpLists('team-1')).resolves.toMatchObject([
      { id: 'analytics-list', space: { name: 'Analytics' } },
      { id: 'list-1', space: { name: 'Engineering' }, name: 'Inbox' },
      {
        id: 'list-2',
        space: { name: 'Engineering' },
        folder: { name: 'Product' },
        name: 'Backlog',
        statuses: [{ name: 'open' }],
        startDate: '2026-10-12T00:00:00.000Z',
        dueDate: '2026-10-25T00:00:00.000Z',
        taskCount: 66
      }
    ])
    // Spaces, plus one Folder and one folderless call per Space; archived Lists drop out.
    expect(clickUpRequestMock).toHaveBeenCalledTimes(5)
    expect(clickUpRequestMock.mock.calls.map((call) => call[1])).not.toContain(
      expect.stringContaining('/folder/')
    )
  })

  it('serves repeat and concurrent loads from one cached walk', async () => {
    const { listClickUpLists } = await import('./list-hierarchy')

    await Promise.all([listClickUpLists('team-1'), listClickUpLists('team-1')])
    await listClickUpLists('team-1')

    expect(clickUpRequestMock).toHaveBeenCalledTimes(5)
  })

  it('reads a single List with one request when listId is given', async () => {
    const { listClickUpLists } = await import('./list-hierarchy')

    await expect(listClickUpLists('team-1', 'list-9')).resolves.toMatchObject([
      { id: 'list-9', name: 'Solo' }
    ])
    expect(clickUpRequestMock).toHaveBeenCalledTimes(1)
  })

  it('loads and caches full List statuses after a hierarchy summary was cached', async () => {
    const { listClickUpLists } = await import('./list-hierarchy')
    await listClickUpLists('team-1', null, 'space-1')
    clickUpRequestMock.mockResolvedValue({
      id: 'list-1',
      name: 'Inbox',
      statuses: [
        { status: 'in progress', type: 'custom' },
        { status: 'complete', type: 'closed' }
      ]
    })
    clickUpRequestMock.mockClear()

    const [first, concurrent] = await Promise.all([
      listClickUpLists('team-1', 'list-1'),
      listClickUpLists('team-1', 'list-1')
    ])
    expect(first[0]?.statuses.map((status) => status.name)).toEqual(['in progress', 'complete'])
    expect(concurrent).toEqual(first)
    await expect(listClickUpLists('team-1', 'list-1')).resolves.toEqual(first)
    expect(clickUpRequestMock).toHaveBeenCalledTimes(1)
  })

  it('does not reuse cached List details after reconnecting with another token', async () => {
    const { listClickUpLists } = await import('./list-hierarchy')
    clickUpRequestMock.mockResolvedValue({
      id: 'list-1',
      name: 'Inbox',
      statuses: [{ status: 'open', type: 'open' }]
    })
    await listClickUpLists('team-1', 'list-1')
    getClientsMock.mockReturnValue([{ ...client(), token: 'pk_other' }])
    clickUpRequestMock.mockResolvedValue({
      id: 'list-1',
      name: 'Inbox',
      statuses: [{ status: 'review', type: 'custom' }]
    })

    const lists = await listClickUpLists('team-1', 'list-1')
    expect(lists[0]?.statuses.map((status) => status.name)).toEqual(['review'])
  })

  it('refetches after a failed walk instead of caching the failure', async () => {
    clickUpRequestMock.mockRejectedValueOnce(new Error('Rate limit reached'))
    const { listClickUpLists } = await import('./list-hierarchy')

    await expect(listClickUpLists('team-1')).rejects.toThrow('Rate limit reached')
    mockHierarchy()
    await expect(listClickUpLists('team-1')).resolves.toHaveLength(3)
  })

  it('walks only the selected Space and lists Spaces with their statuses', async () => {
    const { listClickUpLists, listClickUpSpaces } = await import('./list-hierarchy')

    await expect(listClickUpSpaces('team-1')).resolves.toMatchObject([
      { id: 'space-2', name: 'Analytics', statuses: [] },
      {
        id: 'space-1',
        statuses: [
          { name: 'to do', type: 'open' },
          { name: 'complete', type: 'closed' }
        ]
      }
    ])
    await expect(listClickUpLists('team-1', null, 'space-2')).resolves.toMatchObject([
      { id: 'analytics-list' }
    ])
    // One Spaces read (shared), then two reads for the selected Space only.
    expect(clickUpRequestMock).toHaveBeenCalledTimes(3)
  })
})

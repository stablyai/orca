import { beforeEach, describe, expect, it, vi } from 'vitest'

const { clickUpRequestMock, getClientsMock, getClickUpTaskInWorkspaceMock } = vi.hoisted(() => ({
  clickUpRequestMock: vi.fn(),
  getClientsMock: vi.fn(),
  getClickUpTaskInWorkspaceMock: vi.fn()
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
  requireClickUpClient: (workspaceId?: string) => getClientsMock(workspaceId)[0]
}))

vi.mock('./task-lookup', () => ({
  getClickUpTaskInWorkspace: (...args: unknown[]) => getClickUpTaskInWorkspaceMock(...args)
}))

describe('ClickUp task comments', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getClientsMock.mockReturnValue([{ workspace: { id: 'team-1', name: 'Team' }, token: 'pk' }])
    getClickUpTaskInWorkspaceMock.mockResolvedValue({
      id: 'native-1',
      workspaceId: 'team-1',
      name: 'Task',
      url: 'https://app.clickup.com/t/native-1',
      status: { name: 'open', type: 'open', color: '', orderIndex: 0 },
      list: { id: 'list-1', name: 'Backlog' },
      assignees: [],
      tags: [],
      createdAt: '',
      updatedAt: ''
    })
    clickUpRequestMock.mockResolvedValue({ comments: [] })
  })

  it('resolves custom task ids before reading comments', async () => {
    const { getClickUpTaskComments } = await import('./task-comments')
    await getClickUpTaskComments('CHP-1', 'team-1')
    expect(getClickUpTaskInWorkspaceMock).toHaveBeenCalled()
    expect(String(clickUpRequestMock.mock.calls[0][1])).toContain('/task/native-1/comment')
  })
})

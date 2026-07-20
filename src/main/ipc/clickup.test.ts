import { beforeEach, describe, expect, it, vi } from 'vitest'

const { createTaskMock, handleMock } = vi.hoisted(() => ({
  createTaskMock: vi.fn(),
  handleMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: { handle: handleMock }
}))

vi.mock('../clickup/client', () => ({
  connect: vi.fn(),
  disconnect: vi.fn(),
  getStatus: vi.fn(),
  selectWorkspace: vi.fn(),
  testConnection: vi.fn()
}))

vi.mock('../clickup/tasks', () => ({
  addTaskComment: vi.fn(),
  createTask: createTaskMock,
  getTask: vi.fn(),
  getTaskComments: vi.fn(),
  listLists: vi.fn(),
  listTasks: vi.fn(),
  listWorkspaceMembers: vi.fn(),
  listWorkspaceTags: vi.fn(),
  searchTasks: vi.fn(),
  updateTask: vi.fn()
}))

vi.mock('./preflight', () => ({
  _resetPreflightCache: vi.fn()
}))

import { registerClickUpHandlers } from './clickup'

type Handler = (_event: unknown, args: Record<string, unknown>) => unknown

describe('registerClickUpHandlers', () => {
  const handlers: Record<string, Handler> = {}

  beforeEach(() => {
    handleMock.mockReset()
    createTaskMock.mockReset()
    for (const key of Object.keys(handlers)) {
      delete handlers[key]
    }
    handleMock.mockImplementation((channel, handler) => {
      handlers[channel] = handler
    })
    registerClickUpHandlers()
  })

  it.each([
    [{ priority: 0 }, 'Invalid priority.'],
    [{ priority: 5 }, 'Invalid priority.'],
    [{ dueDate: '07/31/2026' }, 'Invalid due date.'],
    [{ timeEstimate: -1 }, 'Invalid time estimate.'],
    [{ timeEstimate: Number.NaN }, 'Invalid time estimate.']
  ])('rejects invalid create fields before calling ClickUp', async (fields, error) => {
    await expect(
      handlers['clickup:createTask'](null, {
        listId: 'list-1',
        name: 'Task',
        ...fields
      })
    ).resolves.toEqual({ ok: false, error })
    expect(createTaskMock).not.toHaveBeenCalled()
  })
})

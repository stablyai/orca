import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { KanbanConnectResult, KanbanTaskDetails } from '../../shared/kanban-types'
import type * as KanbanClientModule from '../kanban/client'

const {
  handleMock,
  createClientMock,
  connectMock,
  disconnectMock,
  getStatusMock,
  listTasksMock,
  getTaskMock
} = vi.hoisted(() => ({
  handleMock: vi.fn(),
  createClientMock: vi.fn(),
  connectMock: vi.fn(),
  disconnectMock: vi.fn(),
  getStatusMock: vi.fn(),
  listTasksMock: vi.fn(),
  getTaskMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: handleMock
  }
}))

// Why: keep the real KanbanRequestError so the fixed invalid-token message
// stays under test; only the client factory is replaced.
vi.mock('../kanban/client', async (importOriginal) => {
  const actual = await importOriginal<typeof KanbanClientModule>()
  return { ...actual, createKanbanClient: createClientMock }
})

import { registerKanbanHandlers } from './kanban'

type HandlerMap = Record<string, (_event: unknown, args?: unknown) => unknown>

describe('registerKanbanHandlers', () => {
  const handlers: HandlerMap = {}

  beforeEach(() => {
    handleMock.mockReset()
    createClientMock.mockReset()
    connectMock.mockReset()
    disconnectMock.mockReset()
    getStatusMock.mockReset()
    listTasksMock.mockReset()
    getTaskMock.mockReset()
    for (const key of Object.keys(handlers)) {
      delete handlers[key]
    }
    handleMock.mockImplementation((channel, handler) => {
      handlers[channel] = handler
    })
    createClientMock.mockReturnValue({
      connect: connectMock,
      disconnect: disconnectMock,
      getStatus: getStatusMock,
      listTasks: listTasksMock,
      getTask: getTaskMock
    })
  })

  it('registers the five narrow kanban:* channels and wires a real fetch', async () => {
    getStatusMock.mockReturnValue({ connected: false, reason: 'missing' })
    registerKanbanHandlers()

    for (const channel of [
      'kanban:connect',
      'kanban:disconnect',
      'kanban:status',
      'kanban:listTasks',
      'kanban:getTask'
    ]) {
      expect(handleMock).toHaveBeenCalledWith(channel, expect.any(Function))
    }
    // Why: the renderer must never supply headers/URLs/fetch options; the
    // client is created in main with the process-wide fetch on first use.
    await handlers['kanban:status'](null)
    expect(createClientMock).toHaveBeenCalledWith({ fetch: expect.any(Function) })
  })

  it('connects with a trimmed token and returns the viewer without echoing it', async () => {
    connectMock.mockResolvedValue({
      ok: true,
      viewer: { id: 'user-1', name: 'Ada', level: 'admin' }
    })
    registerKanbanHandlers()

    const result = (await handlers['kanban:connect'](null, {
      token: '  token-secret  '
    })) as KanbanConnectResult

    expect(connectMock).toHaveBeenCalledWith('token-secret')
    expect(result).toEqual({
      ok: true,
      viewer: { id: 'user-1', name: 'Ada', level: 'admin' }
    })
    expect(JSON.stringify(result)).not.toContain('token-secret')
  })

  it('rejects an empty token without touching the client', async () => {
    registerKanbanHandlers()

    const result = (await handlers['kanban:connect'](null, {
      token: '   '
    })) as KanbanConnectResult

    expect(result).toEqual({
      ok: false,
      code: 'invalid_token',
      error: 'Enter a Kanban personal token.'
    })
    expect(connectMock).not.toHaveBeenCalled()
  })

  it('rejects a non-string token', async () => {
    registerKanbanHandlers()

    const result = (await handlers['kanban:connect'](null, {
      token: 12345
    })) as KanbanConnectResult

    expect(result.ok).toBe(false)
    expect(connectMock).not.toHaveBeenCalled()
  })

  it('rejects an oversized token', async () => {
    registerKanbanHandlers()

    const result = (await handlers['kanban:connect'](null, {
      token: 'x'.repeat(5000)
    })) as KanbanConnectResult

    expect(result.ok).toBe(false)
    expect(connectMock).not.toHaveBeenCalled()
  })

  it('disconnects and returns connection status', async () => {
    getStatusMock.mockReturnValue({ connected: false, reason: 'missing' })
    registerKanbanHandlers()

    await handlers['kanban:disconnect'](null)
    const status = await handlers['kanban:status'](null)

    expect(disconnectMock).toHaveBeenCalled()
    expect(status).toEqual({ connected: false, reason: 'missing' })
  })

  it('forwards a valid filter to listTasks', async () => {
    listTasksMock.mockResolvedValue({
      tasks: [],
      lanes: [],
      receivedAt: '2026-08-27T00:00:00.000Z'
    })
    registerKanbanHandlers()

    await handlers['kanban:listTasks'](null, {
      filter: { role: 'executor', laneId: 'L-1', urgent: true, includeDone: false }
    })

    expect(listTasksMock).toHaveBeenCalledWith({
      role: 'executor',
      laneId: 'L-1',
      urgent: true,
      includeDone: false
    })
  })

  it('lists tasks without a filter when args are omitted', async () => {
    listTasksMock.mockResolvedValue({
      tasks: [],
      lanes: [],
      receivedAt: '2026-08-27T00:00:00.000Z'
    })
    registerKanbanHandlers()

    await handlers['kanban:listTasks'](null, undefined)

    expect(listTasksMock).toHaveBeenCalledWith(undefined)
  })

  it('rejects an unknown filter role enum', async () => {
    registerKanbanHandlers()

    await expect(
      handlers['kanban:listTasks'](null, { filter: { role: 'nonsense' } })
    ).rejects.toThrow('Invalid Kanban task filter.')
    expect(listTasksMock).not.toHaveBeenCalled()
  })

  it('rejects a non-string lane id', async () => {
    registerKanbanHandlers()

    await expect(
      handlers['kanban:listTasks'](null, { filter: { role: 'executor', laneId: 42 } })
    ).rejects.toThrow('Invalid Kanban task filter.')
    expect(listTasksMock).not.toHaveBeenCalled()
  })

  it('rejects an oversized search query', async () => {
    registerKanbanHandlers()

    await expect(
      handlers['kanban:listTasks'](null, { filter: { role: 'executor', query: 'x'.repeat(300) } })
    ).rejects.toThrow('Invalid Kanban task filter.')
    expect(listTasksMock).not.toHaveBeenCalled()
  })

  it('returns task details for a trimmed id', async () => {
    const details = {
      id: 'K-1',
      title: 'Fix login',
      laneId: 'L-1',
      laneName: 'Backlog',
      due: null,
      urgent: false,
      repositoryUrls: [],
      taskVersion: 1,
      executors: [],
      observers: [],
      createdBy: null,
      url: 'https://kanban.fpimi.ru/?task=K-1',
      result: '',
      description: '',
      tags: [],
      source: null,
      comments: [],
      blockedBy: [],
      attachments: [],
      subtasks: []
    } as KanbanTaskDetails
    getTaskMock.mockResolvedValue(details)
    registerKanbanHandlers()

    const result = await handlers['kanban:getTask'](null, { id: ' K-1 ' })

    expect(getTaskMock).toHaveBeenCalledWith('K-1')
    expect(result).toBe(details)
  })

  it('returns null for an empty id', async () => {
    registerKanbanHandlers()

    const result = await handlers['kanban:getTask'](null, { id: '   ' })

    expect(result).toBeNull()
    expect(getTaskMock).not.toHaveBeenCalled()
  })

  it('returns null for a non-string id', async () => {
    registerKanbanHandlers()

    const result = await handlers['kanban:getTask'](null, { id: 42 })

    expect(result).toBeNull()
    expect(getTaskMock).not.toHaveBeenCalled()
  })

  it('returns null for an oversized id', async () => {
    registerKanbanHandlers()

    const result = await handlers['kanban:getTask'](null, { id: 'x'.repeat(600) })

    expect(result).toBeNull()
    expect(getTaskMock).not.toHaveBeenCalled()
  })
})

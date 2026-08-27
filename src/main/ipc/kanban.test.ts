import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type * as Os from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  KanbanConnectResult,
  KanbanMarkStartedResult,
  KanbanTaskDetails
} from '../../shared/kanban-types'
import type * as KanbanClientModule from '../kanban/client'

const {
  handleMock,
  createClientMock,
  connectMock,
  disconnectMock,
  getStatusMock,
  listTasksMock,
  getTaskMock,
  markStartedMock
} = vi.hoisted(() => ({
  handleMock: vi.fn(),
  createClientMock: vi.fn(),
  connectMock: vi.fn(),
  disconnectMock: vi.fn(),
  getStatusMock: vi.fn(),
  listTasksMock: vi.fn(),
  getTaskMock: vi.fn(),
  markStartedMock: vi.fn()
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

vi.mock('../kanban/mark-started', () => ({
  markKanbanTaskStarted: markStartedMock
}))

import { registerKanbanHandlers } from './kanban'

type HandlerMap = Record<string, (_event: unknown, args?: unknown) => unknown>

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

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
    markStartedMock.mockReset()
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

  // Why: this test drives the REAL client through the IPC handlers so the
  // state machine is exercised, not forced. It fails if `disconnect` drops
  // its `authInvalidated = false` reset or its credential clearing, and if a
  // successful reconnect fails to refresh the status back to connected.
  it('disconnect clears invalid auth state and reconnect restores connected', async () => {
    const tempHome = mkdtempSync(join(tmpdir(), 'orca-kanban-ipc-'))
    try {
      vi.resetModules()
      const { setSecretStore } = await import('../../shared/secret-store')
      setSecretStore({
        isEncryptionAvailable: () => true,
        encryptString: (value: string) => Buffer.from(value),
        decryptString: (value: Buffer) => value.toString('utf-8'),
        describeProtectionGap: () => null
      })
      vi.doMock('node:os', async () => {
        const actual = await vi.importActual<typeof Os>('node:os')
        return { ...actual, homedir: () => tempHome }
      })

      const fetchMock = vi.fn<typeof fetch>()
      const clientModule = await vi.importActual<typeof KanbanClientModule>('../kanban/client')
      createClientMock.mockImplementation(() =>
        clientModule.createKanbanClient({
          fetch: fetchMock as typeof fetch,
          now: () => Date.parse('2026-08-27T10:00:00Z')
        })
      )
      const kanbanModule = await import('./kanban')
      kanbanModule.registerKanbanHandlers()

      const viewer = { id: 'user-1', name: 'Ada', level: 'admin' }

      fetchMock.mockResolvedValueOnce(jsonResponse(viewer))
      expect(await handlers['kanban:connect'](null, { token: 'token-secret' })).toEqual({
        ok: true,
        viewer
      })
      expect(await handlers['kanban:status'](null)).toEqual({ connected: true, viewer })

      fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'nope' }, 401))
      await expect(
        handlers['kanban:listTasks'](null, { filter: { role: 'executor' } })
      ).rejects.toMatchObject({ code: 'unauthorized' })
      expect(await handlers['kanban:status'](null)).toEqual({
        connected: false,
        reason: 'invalid'
      })

      await handlers['kanban:disconnect'](null)
      expect(await handlers['kanban:status'](null)).toEqual({
        connected: false,
        reason: 'missing'
      })

      fetchMock.mockResolvedValueOnce(jsonResponse(viewer))
      expect(await handlers['kanban:connect'](null, { token: 'token-new' })).toEqual({
        ok: true,
        viewer
      })
      expect(await handlers['kanban:status'](null)).toEqual({ connected: true, viewer })
    } finally {
      rmSync(tempHome, { recursive: true, force: true })
    }
  })
})

describe('registerKanbanHandlers markStarted', () => {
  const handlers: HandlerMap = {}

  beforeEach(() => {
    handleMock.mockReset()
    markStartedMock.mockReset()
    for (const key of Object.keys(handlers)) {
      delete handlers[key]
    }
    handleMock.mockImplementation((channel, handler) => {
      handlers[channel] = handler
    })
    markStartedMock.mockResolvedValue({ ok: true, moved: true, commented: true })
  })

  it('registers and invokes the kanban:markStarted channel', async () => {
    registerKanbanHandlers()
    expect(handleMock).toHaveBeenCalledWith('kanban:markStarted', expect.any(Function))

    const result = await handlers['kanban:markStarted'](null, {
      taskId: ' K-1 ',
      projectName: ' Widgets ',
      branch: 'feature-x'
    })

    expect(markStartedMock).toHaveBeenCalledWith(
      { taskId: 'K-1', projectName: 'Widgets', branch: 'feature-x' },
      { fetch: expect.any(Function) }
    )
    expect(result).toEqual({ ok: true, moved: true, commented: true })
  })

  it('forwards a comment-only retry marker', async () => {
    registerKanbanHandlers()

    await handlers['kanban:markStarted'](null, {
      taskId: 'K-1',
      projectName: 'Widgets',
      branch: null,
      retry: 'comment-only'
    })

    expect(markStartedMock).toHaveBeenCalledWith(
      { taskId: 'K-1', projectName: 'Widgets', branch: null, retry: 'comment-only' },
      { fetch: expect.any(Function) }
    )
  })

  it.each([
    ['empty taskId', { taskId: '   ', projectName: 'Widgets', branch: 'feature-x' }],
    ['oversized taskId', { taskId: 'x'.repeat(600), projectName: 'Widgets', branch: 'feature-x' }],
    ['non-string taskId', { taskId: 42, projectName: 'Widgets', branch: 'feature-x' }],
    ['empty projectName', { taskId: 'K-1', projectName: '   ', branch: 'feature-x' }],
    ['oversized projectName', { taskId: 'K-1', projectName: 'x'.repeat(400), branch: 'feature-x' }],
    ['non-string projectName', { taskId: 'K-1', projectName: 42, branch: 'feature-x' }],
    ['non-string branch', { taskId: 'K-1', projectName: 'Widgets', branch: 42 }],
    ['oversized branch', { taskId: 'K-1', projectName: 'Widgets', branch: 'x'.repeat(400) }],
    ['invalid retry', { taskId: 'K-1', projectName: 'Widgets', branch: 'feature-x', retry: 'nonsense' }]
  ])('rejects %s without touching the operation', async (_label, args) => {
    registerKanbanHandlers()

    const result = (await handlers['kanban:markStarted'](null, args)) as KanbanMarkStartedResult

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.moved).toBe(false)
      expect(result.commented).toBe(false)
    }
    expect(markStartedMock).not.toHaveBeenCalled()
  })
})

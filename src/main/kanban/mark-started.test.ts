import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type * as Os from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { KanbanMarkStartedResult } from '../../shared/kanban-types'

let tempHome = ''
let fetchMock: Mock<typeof fetch>

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

function rawTask(overrides: { id?: string; lane?: string; task_version?: number } = {}) {
  return {
    id: overrides.id ?? 'K-1',
    t: 'Fix login',
    lane: overrides.lane ?? 'L-open',
    task_version: overrides.task_version ?? 1,
    executors: [],
    observers: [],
    created_by: null,
    due: null,
    hot: false,
    result: null,
    d: null,
    tag: [],
    src: null,
    repo: null,
    gh: null,
    blocked_by: [],
    attachments: [],
    subtasks: [],
    c: []
  }
}

const LIST = {
  lanes: [
    { id: 'L-open', name: 'Открыто' },
    { id: 'L-inwork', name: 'В работе' }
  ],
  tasks: [rawTask()]
}

async function loadMarkStarted() {
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
  const [module, store] = await Promise.all([
    import('./mark-started'),
    import('./credential-store')
  ])
  store.saveKanbanCredential({
    token: 'token-secret',
    viewer: { id: 'user-1', name: 'Ada', level: 'admin' }
  })
  const deps = {
    fetch: (input: RequestInfo | URL, init?: RequestInit) => fetchMock(input, init),
    timeoutMs: 5000
  }
  return { markKanbanTaskStarted: module.markKanbanTaskStarted, deps }
}

function callArgs(index: number): [string, RequestInit] {
  return fetchMock.mock.calls[index] as [string, RequestInit]
}

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'orca-kanban-mark-started-'))
  fetchMock = vi.fn<typeof fetch>()
})

describe('markKanbanTaskStarted', () => {
  it('moves and comments in the exact sequence with the exact templates', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(LIST))
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }))
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }))
    const { markKanbanTaskStarted, deps } = await loadMarkStarted()

    const result = await markKanbanTaskStarted(
      { taskId: 'K-1', projectName: 'Widgets', branch: 'feature-x' },
      deps
    )

    expect(result).toEqual({ ok: true, moved: true, commented: true })
    expect(fetchMock).toHaveBeenCalledTimes(3)
    const [listCall, moveCall, commentCall] = [callArgs(0), callArgs(1), callArgs(2)]
    expect(listCall[0]).toBe('https://kanban.fpimi.ru/api/tasks')
    expect(moveCall[0]).toBe('https://kanban.fpimi.ru/api/tasks/K-1/move')
    expect(JSON.parse(String(moveCall[1].body))).toEqual({ lane: 'L-inwork', task_version: 1 })
    expect(moveCall[1].headers).toMatchObject({ Authorization: 'Bearer token-secret' })
    expect(commentCall[0]).toBe('https://kanban.fpimi.ru/api/tasks/K-1/comments')
    expect(JSON.parse(String(commentCall[1].body))).toEqual({
      text: 'Orca: начата работа — проект Widgets, ветка feature-x.'
    })
    expect(JSON.stringify(result)).not.toContain('token-secret')
  })

  it('skips the move when the task is already in the В работе lane', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ ...LIST, tasks: [rawTask({ lane: 'L-inwork' })] })
    )
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }))
    const { markKanbanTaskStarted, deps } = await loadMarkStarted()

    const result = await markKanbanTaskStarted(
      { taskId: 'K-1', projectName: 'Widgets', branch: 'feature-x' },
      deps
    )

    expect(result).toEqual({ ok: true, moved: false, commented: true })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(String(callArgs(1)[0])).toContain('/comments')
  })

  it('refetches and retries the move once after a first 409', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(LIST))
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'conflict' }, 409))
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ ...LIST, tasks: [rawTask({ task_version: 2 })] })
    )
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }))
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }))
    const { markKanbanTaskStarted, deps } = await loadMarkStarted()

    const result = await markKanbanTaskStarted(
      { taskId: 'K-1', projectName: 'Widgets', branch: 'feature-x' },
      deps
    )

    expect(result).toEqual({ ok: true, moved: true, commented: true })
    const moveCalls = fetchMock.mock.calls
      .map((call, index) => ({ call, index }))
      .filter(({ call }) => String(call[0]).endsWith('/move'))
    expect(moveCalls).toHaveLength(2)
    expect(JSON.parse(String(moveCalls[0].call[1]?.body))).toEqual({
      lane: 'L-inwork',
      task_version: 1
    })
    expect(JSON.parse(String(moveCalls[1].call[1]?.body))).toEqual({
      lane: 'L-inwork',
      task_version: 2
    })
  })

  it('fails with a typed conflict when the second move also 409s', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(LIST))
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'conflict' }, 409))
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ ...LIST, tasks: [rawTask({ task_version: 2 })] })
    )
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'conflict' }, 409))
    const { markKanbanTaskStarted, deps } = await loadMarkStarted()

    const result = await markKanbanTaskStarted(
      { taskId: 'K-1', projectName: 'Widgets', branch: 'feature-x' },
      deps
    )

    expect(result).toMatchObject({
      ok: false,
      moved: false,
      commented: false,
      retry: 'all',
      code: 'conflict'
    })
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('returns comment-only retry when the move succeeds but the comment fails', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(LIST))
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }))
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'nope' }, 500))
    const { markKanbanTaskStarted, deps } = await loadMarkStarted()

    const result = await markKanbanTaskStarted(
      { taskId: 'K-1', projectName: 'Widgets', branch: 'feature-x' },
      deps
    )

    expect(result).toMatchObject({
      ok: false,
      moved: true,
      commented: false,
      retry: 'comment-only',
      code: 'server'
    })
    const moveCalls = fetchMock.mock.calls.filter((call) => String(call[0]).endsWith('/move'))
    expect(moveCalls).toHaveLength(1)
  })

  it('skips the move on a comment-only retry and does not GET the task list', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }))
    const { markKanbanTaskStarted, deps } = await loadMarkStarted()

    const result = await markKanbanTaskStarted(
      { taskId: 'K-1', projectName: 'Widgets', branch: 'feature-x', retry: 'comment-only' },
      deps
    )

    expect(result).toEqual({ ok: true, moved: false, commented: true })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [commentCall] = [callArgs(0)]
    expect(String(commentCall[0])).toBe('https://kanban.fpimi.ru/api/tasks/K-1/comments')
  })

  it('sanitizes workspace data so it cannot inject extra comment lines', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(LIST))
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }))
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }))
    const { markKanbanTaskStarted, deps } = await loadMarkStarted()

    await markKanbanTaskStarted(
      { taskId: 'K-1', projectName: 'Acme\nWidgets', branch: 'feat\nure' },
      deps
    )

    const commentBody = String(callArgs(2)[1].body)
    expect(commentBody).not.toContain('\n')
    expect(commentBody).toContain('проект Acme Widgets')
    expect(commentBody).toContain('ветка feat ure')
  })

  it('types auth failures without leaking the token', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'nope' }, 401))
    const { markKanbanTaskStarted, deps } = await loadMarkStarted()

    const result = await markKanbanTaskStarted(
      { taskId: 'K-1', projectName: 'Widgets', branch: 'feature-x' },
      deps
    )

    expect(result).toMatchObject({
      ok: false,
      moved: false,
      commented: false,
      retry: 'all',
      code: 'unauthorized'
    })
    expect(JSON.stringify(result)).not.toContain('token-secret')
  })

  it('types network failures', async () => {
    fetchMock.mockRejectedValueOnce(new Error('offline'))
    const { markKanbanTaskStarted, deps } = await loadMarkStarted()

    const result = await markKanbanTaskStarted(
      { taskId: 'K-1', projectName: 'Widgets', branch: 'feature-x' },
      deps
    )

    expect(result).toMatchObject({
      ok: false,
      moved: false,
      commented: false,
      retry: 'all',
      code: 'network'
    })
  })

  it('reports server when the task or target lane is missing from the board', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ...LIST, tasks: [rawTask({ id: 'K-9' })] }))
    const { markKanbanTaskStarted, deps } = await loadMarkStarted()

    const result: KanbanMarkStartedResult = await markKanbanTaskStarted(
      { taskId: 'K-1', projectName: 'Widgets', branch: 'feature-x' },
      deps
    )

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('server')
    }
  })

  it('invalidates the shared auth state on 401 so getStatus reports disconnected', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'nope' }, 401))
    const { markKanbanTaskStarted, deps } = await loadMarkStarted()
    const { createKanbanClient } = await import('./client')
    const client = createKanbanClient({
      fetch: (input: RequestInfo | URL, init?: RequestInit) => fetchMock(input, init),
      now: () => Date.parse('2026-08-27T10:00:00Z'),
      timeoutMs: 5000
    })

    expect(client.getStatus()).toEqual({
      connected: true,
      viewer: { id: 'user-1', name: 'Ada', level: 'admin' }
    })

    const result = await markKanbanTaskStarted(
      { taskId: 'K-1', projectName: 'Widgets', branch: 'feature-x' },
      deps
    )

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('unauthorized')
    }
    expect(client.getStatus()).toEqual({ connected: false, reason: 'invalid' })
  })
})

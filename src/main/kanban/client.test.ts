import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type * as Os from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { KANBAN_SERVER_URL } from '../../shared/kanban-types'
import type { KanbanTaskSummary } from '../../shared/kanban-types'

let tempHome = ''
let nowValue = 0
let fetchMock: Mock<typeof fetch>

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

async function loadClient(options: { timeoutMs?: number; decryptError?: Error } = {}) {
  vi.resetModules()
  const { setSecretStore } = await import('../../shared/secret-store')
  setSecretStore({
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(value),
    decryptString:
      options.decryptError !== undefined
        ? () => {
            throw options.decryptError
          }
        : (value: Buffer) => value.toString('utf-8'),
    describeProtectionGap: () => null
  })
  vi.doMock('node:os', async () => {
    const actual = await vi.importActual<typeof Os>('node:os')
    return { ...actual, homedir: () => tempHome }
  })
  const [clientModule, store] = await Promise.all([
    import('./client'),
    import('./credential-store')
  ])
  const client = clientModule.createKanbanClient({
    fetch: (input, init) => fetchMock(input, init),
    now: () => nowValue,
    timeoutMs: options.timeoutMs ?? 5000
  })
  return { ...clientModule, store, client }
}

function fixtureTask(overrides: Partial<KanbanTaskSummary> = {}): KanbanTaskSummary {
  return {
    id: 'K-1',
    title: 'Fix login',
    laneId: 'L-1',
    laneName: 'Backlog',
    due: '2026-09-01',
    urgent: false,
    repositoryUrls: [],
    taskVersion: 1,
    executors: [{ id: 'user-1', name: 'Ada' }],
    observers: [],
    createdBy: null,
    url: 'https://kanban.fpimi.ru/?task=K-1',
    ...overrides
  }
}

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'orca-kanban-client-'))
  nowValue = Date.parse('2026-08-27T10:00:00Z')
  fetchMock = vi.fn<typeof fetch>()
})

describe('Kanban client', () => {
  it('uses the current /api/me, list, and detail envelopes in sequence', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          user: { user_id: 'user-1', name: 'Ada', platform_role: 'admin' },
          csrf: 'csrf-secret'
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          schema: 2,
          version: 1,
          lanes: ['Backlog'],
          users: [{ id: 'user-1', name: 'Ada' }],
          tasks: [
            {
              id: 'K-1',
              t: 'Fix login',
              lane: 'Backlog',
              task_version: 1,
              executors: ['user-1'],
              hot: 0
            }
          ]
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          task: {
            id: 'K-1',
            t: 'Fix login',
            lane: 'Backlog',
            task_version: 1,
            executors: ['user-1'],
            hot: 0
          }
        })
      )
    const { client } = await loadClient()

    await expect(client.connect('token-secret')).resolves.toMatchObject({ ok: true })
    await expect(client.listTasks()).resolves.toMatchObject({ tasks: [{ id: 'K-1' }] })
    await expect(client.getTask('K-1')).resolves.toMatchObject({ id: 'K-1' })

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `${KANBAN_SERVER_URL}/api/me`,
      `${KANBAN_SERVER_URL}/api/tasks`,
      `${KANBAN_SERVER_URL}/api/tasks/K-1`
    ])

    fetchMock.mockResolvedValueOnce(jsonResponse({ task: { id: 'K-2' } }))
    await expect(client.getTask('K-2')).rejects.toMatchObject({ code: 'invalid_response' })
  })

  it('loads list context before a direct getTask and rejects malformed context', async () => {
    const { client, store } = await loadClient()
    store.saveKanbanCredential({
      token: 'token-secret',
      viewer: { id: 'user-1', name: 'Ada', level: 'admin' }
    })
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          lanes: ['Backlog'],
          users: [{ id: 'user-1', name: 'Ada' }],
          tasks: []
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          task: {
            id: 'K / 1',
            t: 'Direct detail',
            lane: 'Backlog',
            task_version: 1,
            created_by: 'user-1'
          }
        })
      )

    await expect(client.getTask('K / 1')).resolves.toMatchObject({
      id: 'K / 1',
      createdBy: { id: 'user-1', name: 'Ada' }
    })
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `${KANBAN_SERVER_URL}/api/tasks`,
      `${KANBAN_SERVER_URL}/api/tasks/K%20%2F%201`
    ])

    const malformed = await loadClient()
    malformed.store.saveKanbanCredential({
      token: 'token-secret',
      viewer: { id: 'user-1', name: 'Ada', level: 'admin' }
    })
    fetchMock.mockReset().mockResolvedValueOnce(jsonResponse({ lanes: [], users: {}, tasks: [] }))
    await expect(malformed.client.getTask('K-2')).rejects.toMatchObject({
      code: 'invalid_response'
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('connects with a trimmed Bearer token against the fixed origin', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 'user-1', name: 'Ada', level: 'admin' }))
    const { client, store } = await loadClient()

    const result = await client.connect('  token-secret  ')

    expect(result).toEqual({
      ok: true,
      viewer: { id: 'user-1', name: 'Ada', level: 'admin' }
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${KANBAN_SERVER_URL}/api/me`)
    const headers = init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer token-secret')
    expect(headers.Accept).toBe('application/json')
    expect(store.hasStoredKanbanCredential()).toBe(true)
    expect(store.getStoredKanbanMetadata()).toMatchObject({ viewerId: 'user-1', viewerName: 'Ada' })
  })

  it('rejects an empty or whitespace token without calling fetch', async () => {
    const { client } = await loadClient()

    expect(await client.connect('   ')).toEqual({
      ok: false,
      code: 'invalid_token',
      error: expect.any(String)
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns a typed unauthorized result and saves nothing on 401', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'nope' }, 401))
    const { client, store } = await loadClient()

    const result = await client.connect('token-bad')
    expect(result).toEqual({ ok: false, code: 'unauthorized', error: expect.any(String) })
    expect(store.hasStoredKanbanCredential()).toBe(false)
    expect(store.getStoredKanbanMetadata()).toBeNull()
  })

  it('returns invalid_response when /api/me returns malformed JSON', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 'user-1' }))
    const { client } = await loadClient()

    expect(await client.connect('token-malformed')).toEqual({
      ok: false,
      code: 'invalid_response',
      error: expect.any(String)
    })
  })

  it('reports missing status when nothing is stored and connected after connect', async () => {
    const { client, store } = await loadClient()

    expect(client.getStatus()).toEqual({ connected: false, reason: 'missing' })

    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 'user-1', name: 'Ada', level: 'admin' }))
    await client.connect('token-secret')

    expect(client.getStatus()).toEqual({
      connected: true,
      viewer: { id: 'user-1', name: 'Ada', level: 'admin' }
    })
    expect(store.hasStoredKanbanCredential()).toBe(true)
  })

  it('disconnect clears the credential and invalid state', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 'user-1', name: 'Ada', level: 'admin' }))
    const { client, store } = await loadClient()
    await client.connect('token-secret')

    client.disconnect()

    expect(client.getStatus()).toEqual({ connected: false, reason: 'missing' })
    expect(store.hasStoredKanbanCredential()).toBe(false)
    expect(store.getStoredKanbanMetadata()).toBeNull()
  })

  it('listTasks sends Bearer to /api/tasks and applies the default executor/open filter', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        tasks: [
          {
            id: 'K-4',
            t: 'Urgent one',
            lane: 'L-1',
            task_version: 1,
            executors: [{ id: 'user-1', name: 'Ada' }],
            hot: true,
            due: '2026-09-01'
          },
          {
            id: 'K-1',
            t: 'Fix login',
            lane: 'L-1',
            task_version: 1,
            executors: [{ id: 'user-1', name: 'Ada' }],
            due: '2026-09-10'
          },
          {
            id: 'K-2',
            t: 'Not mine',
            lane: 'L-1',
            task_version: 1,
            executors: [{ id: 'user-2', name: 'Bob' }]
          },
          {
            id: 'K-3',
            t: 'Done one',
            lane: 'L-done',
            task_version: 1,
            executors: [{ id: 'user-1', name: 'Ada' }]
          }
        ],
        lanes: [
          { id: 'L-1', name: 'Backlog' },
          { id: 'L-done', name: 'Сделано' }
        ]
      })
    )
    const { client, store } = await loadClient()
    store.saveKanbanCredential({
      token: 'token-secret',
      viewer: { id: 'user-1', name: 'Ada', level: 'admin' }
    })

    const result = await client.listTasks()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url] = fetchMock.mock.calls[0] as [string]
    expect(url).toBe(`${KANBAN_SERVER_URL}/api/tasks`)
    expect(result.tasks.map((task) => task.id)).toEqual(['K-4', 'K-1'])
    expect(result.lanes).toHaveLength(2)
    expect(result.receivedAt).toBe('2026-08-27T10:00:00.000Z')
  })

  it('listTasks refines with an explicit filter and never leaks non-authorized tasks', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        tasks: [
          {
            id: 'K-5',
            t: 'Observed one',
            lane: 'L-2',
            task_version: 1,
            observers: [{ id: 'user-1', name: 'Ada' }]
          },
          {
            id: 'K-6',
            t: 'Different lane',
            lane: 'L-9',
            task_version: 1,
            executors: [{ id: 'user-1', name: 'Ada' }]
          }
        ],
        lanes: [
          { id: 'L-2', name: 'Review' },
          { id: 'L-9', name: 'Another' }
        ]
      })
    )
    const { client, store } = await loadClient()
    store.saveKanbanCredential({
      token: 'token-secret',
      viewer: { id: 'user-1', name: 'Ada', level: 'admin' }
    })

    const result = await client.listTasks({
      role: 'observer',
      laneId: 'L-2',
      includeDone: false
    })

    expect(result.tasks.map((task) => task.id)).toEqual(['K-5'])
  })

  it('maps a typed network error to the network code', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'))
    const { client, store } = await loadClient()
    store.saveKanbanCredential({
      token: 'token-secret',
      viewer: { id: 'user-1', name: 'Ada', level: 'admin' }
    })

    await expect(client.listTasks()).rejects.toMatchObject({ code: 'network' })
  })

  it('maps an aborted request to the timeout code', async () => {
    fetchMock.mockImplementationOnce(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'TimeoutError'))
          )
        })
    )
    const { client, store } = await loadClient({ timeoutMs: 20 })
    store.saveKanbanCredential({
      token: 'token-secret',
      viewer: { id: 'user-1', name: 'Ada', level: 'admin' }
    })

    await expect(client.listTasks()).rejects.toMatchObject({ code: 'timeout' })
  })

  it('marks the connection invalid after 401 and restores it on reconnect', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'no' }, 401))
    const { client, store } = await loadClient()
    store.saveKanbanCredential({
      token: 'token-secret',
      viewer: { id: 'user-1', name: 'Ada', level: 'admin' }
    })

    await expect(client.listTasks()).rejects.toMatchObject({ code: 'unauthorized' })
    expect(client.getStatus()).toEqual({ connected: false, reason: 'invalid' })

    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 'user-1', name: 'Ada', level: 'admin' }))
    await client.connect('token-secret-2')
    expect(client.getStatus()).toEqual({
      connected: true,
      viewer: { id: 'user-1', name: 'Ada', level: 'admin' }
    })
  })

  it('maps 403 and 409 to their typed codes', async () => {
    const { client, store } = await loadClient()
    store.saveKanbanCredential({
      token: 'token-secret',
      viewer: { id: 'user-1', name: 'Ada', level: 'admin' }
    })

    fetchMock.mockResolvedValueOnce(jsonResponse({}, 403))
    await expect(client.listTasks()).rejects.toMatchObject({ code: 'forbidden' })

    fetchMock.mockResolvedValueOnce(jsonResponse({}, 409))
    await expect(client.listTasks()).rejects.toMatchObject({ code: 'conflict' })
  })

  it('rejects non-JSON and malformed JSON payloads as invalid_response', async () => {
    const { client, store } = await loadClient()
    store.saveKanbanCredential({
      token: 'token-secret',
      viewer: { id: 'user-1', name: 'Ada', level: 'admin' }
    })

    fetchMock.mockResolvedValueOnce(
      new Response('<html>not json</html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' }
      })
    )
    await expect(client.listTasks()).rejects.toMatchObject({ code: 'invalid_response' })

    fetchMock.mockResolvedValueOnce(jsonResponse({ tasks: 'not-an-array' }))
    await expect(client.listTasks()).rejects.toMatchObject({ code: 'invalid_response' })
  })

  it('getTask fetches /api/tasks/{id} and returns null on 404', async () => {
    const details = {
      id: 'K-1',
      t: 'Fix login',
      lane: { id: 'L-1', name: 'Backlog' },
      task_version: 2,
      result: 'Done',
      d: 'desc',
      c: []
    }
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ tasks: [], lanes: [], users: [] }))
      .mockResolvedValueOnce(jsonResponse(details))
    const { client, store } = await loadClient()
    store.saveKanbanCredential({
      token: 'token-secret',
      viewer: { id: 'user-1', name: 'Ada', level: 'admin' }
    })

    const task = await client.getTask('K-1')
    expect(task?.id).toBe('K-1')
    expect(task?.result).toBe('Done')
    const [url] = fetchMock.mock.calls[1] as [string]
    expect(url).toBe(`${KANBAN_SERVER_URL}/api/tasks/K-1`)

    fetchMock.mockResolvedValueOnce(new Response('', { status: 404 }))
    await expect(client.getTask('K-2')).resolves.toBeNull()
  })

  it('sorts urgent first, then earliest due, then no due, then locale-aware title', async () => {
    const { sortKanbanTasks } = await loadClient()
    const tasks = [
      fixtureTask({ id: 'K-a', title: 'Alpha', due: '2026-10-01', urgent: false }),
      fixtureTask({ id: 'K-b', title: 'Beta', due: null, urgent: false }),
      fixtureTask({ id: 'K-c', title: 'Gamma', due: '2026-09-01', urgent: false }),
      fixtureTask({ id: 'K-d', title: 'Delta', due: null, urgent: true })
    ]
    expect(sortKanbanTasks(tasks).map((task) => task.id)).toEqual(['K-d', 'K-c', 'K-a', 'K-b'])
  })

  it('breaks ties on urgency and due with the locale-aware title ordering', async () => {
    const { sortKanbanTasks } = await loadClient()
    // Supplied in reversed title order so the localeCompare fallback must do
    // real work: urgent and due are identical, only the title differs.
    const tasks = [
      fixtureTask({ id: 'K-z', title: 'Zulu', due: '2026-09-01', urgent: false }),
      fixtureTask({ id: 'K-a', title: 'Alpha', due: '2026-09-01', urgent: false }),
      fixtureTask({ id: 'K-m', title: 'Mike', due: '2026-09-01', urgent: false })
    ]
    expect(sortKanbanTasks(tasks).map((task) => task.id)).toEqual(['K-a', 'K-m', 'K-z'])
  })

  it('filters by due, urgent and query', async () => {
    const { filterKanbanTasks } = await loadClient()
    const tasks = [
      fixtureTask({ id: 'K-1', title: 'Overdue', due: '2026-08-01' }),
      fixtureTask({ id: 'K-2', title: 'Today', due: '2026-08-27' }),
      fixtureTask({ id: 'K-3', title: 'No due', due: null }),
      fixtureTask({ id: 'K-4', title: 'Urgent refactor', due: '2026-09-01', urgent: true })
    ]
    const viewerId = 'user-1'

    expect(
      filterKanbanTasks(tasks, viewerId, { role: 'executor', due: 'overdue' }, () => nowValue).map(
        (task) => task.id
      )
    ).toEqual(['K-1'])
    expect(
      filterKanbanTasks(tasks, viewerId, { role: 'executor', due: 'today' }, () => nowValue).map(
        (task) => task.id
      )
    ).toEqual(['K-2'])
    expect(
      filterKanbanTasks(tasks, viewerId, { role: 'executor', due: 'week' }, () => nowValue).map(
        (task) => task.id
      )
    ).toEqual(['K-4'])
    expect(
      filterKanbanTasks(tasks, viewerId, { role: 'executor', due: 'none' }, () => nowValue).map(
        (task) => task.id
      )
    ).toEqual(['K-3'])
    expect(
      filterKanbanTasks(tasks, viewerId, { role: 'executor', urgent: true }, () => nowValue).map(
        (task) => task.id
      )
    ).toEqual(['K-4'])
    expect(
      filterKanbanTasks(
        tasks,
        viewerId,
        { role: 'executor', query: 'refactor' },
        () => nowValue
      ).map((task) => task.id)
    ).toEqual(['K-4'])
    expect(filterKanbanTasks(tasks, viewerId, { role: 'creator' }, () => nowValue)).toHaveLength(0)
  })

  it('surfaces a decrypt failure without leaking the token', async () => {
    const first = await loadClient()
    first.store.saveKanbanCredential({
      token: 'token-secret',
      viewer: { id: 'user-1', name: 'Ada', level: 'admin' }
    })
    const { writeFileSync } = await import('node:fs')
    writeFileSync(
      join(tempHome, '.orca', 'kanban-credential.enc'),
      Buffer.from([0x76, 0x31, 0x30, 0xff, 0xfe])
    )

    const { client, store } = await loadClient({ decryptError: new Error('userCanceledErr') })
    store._resetKanbanCredentialCache()

    await expect(client.listTasks()).rejects.toMatchObject({
      name: 'CredentialDecryptionError'
    })
    expect(client.getStatus()).toEqual({ connected: false, reason: 'decrypt_failed' })
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import { setMainHttpClient } from '../network/http-client'
import { closeTodoistTask, connectTodoist, listTodoistTasks } from './todoist-client'

vi.mock('../network/proxy-settings', () => ({
  ensureElectronProxyFromEnvironment: vi.fn(async () => {})
}))

const saveTodoistCredential = vi.fn()
vi.mock('./todoist-credential-store', () => ({
  loadTodoistToken: () => 'tok',
  saveTodoistCredential: (...args: unknown[]) => saveTodoistCredential(...args),
  clearTodoistCredential: vi.fn(),
  getStoredTodoistViewer: () => null,
  getTodoistCredentialError: () => null
}))

function mockFetch(handler: (url: URL, init?: RequestInit) => unknown): string[] {
  const calls: string[] = []
  setMainHttpClient({
    proxySession: () => null,
    fetch: async (url, init) => {
      calls.push(url)
      const body = handler(new URL(url), init)
      return body instanceof Response ? body : Response.json(body)
    }
  })
  return calls
}

afterEach(() => setMainHttpClient(null))

describe('todoist client', () => {
  it('follows cursors on the filter endpoint and maps tasks with project names', async () => {
    const calls = mockFetch((url) => {
      if (url.pathname === '/api/v1/projects') {
        return { results: [{ id: 'p1', name: 'Work' }], next_cursor: null }
      }
      expect(url.pathname).toBe('/api/v1/tasks/filter')
      expect(url.searchParams.get('query')).toBe('today')
      return url.searchParams.get('cursor')
        ? { results: [{ id: 't2', content: 'Second', project_id: 'p1' }], next_cursor: null }
        : {
            results: [
              {
                id: 't1',
                content: 'First',
                description: 'body',
                project_id: 'p1',
                priority: 4,
                labels: ['x', 3],
                due: { date: '2026-10-01', string: 'today', is_recurring: false },
                checked: true
              }
            ],
            next_cursor: 'c1'
          }
    })

    const tasks = await listTodoistTasks(' today ', 10)

    expect(tasks.map((task) => task.id)).toEqual(['t1', 't2'])
    expect(tasks[0]).toMatchObject({
      projectName: 'Work',
      priority: 4,
      labels: ['x'],
      due: { date: '2026-10-01', string: 'today', isRecurring: false },
      url: 'https://app.todoist.com/app/task/t1',
      completed: true
    })
    expect(tasks[1]).toMatchObject({ priority: 1, due: null, description: '', completed: false })
    expect(calls.filter((url) => url.includes('/tasks/filter'))).toHaveLength(2)
  })

  it('drops deleted tasks and stops on an empty page that still has a cursor', async () => {
    const calls = mockFetch((url) => {
      if (url.pathname === '/api/v1/projects') {
        return { results: [], next_cursor: null }
      }
      return url.searchParams.get('cursor')
        ? { results: [], next_cursor: 'c1' }
        : {
            results: [
              { id: 't1', content: 'Gone', is_deleted: true },
              { id: 't2', content: 'Kept' }
            ],
            next_cursor: 'c1'
          }
    })
    const tasks = await listTodoistTasks('', 50)
    expect(tasks.map((task) => task.id)).toEqual(['t2'])
    expect(calls.filter((url) => new URL(url).pathname === '/api/v1/tasks')).toHaveLength(2)
  })

  it('lists all active tasks when the query is empty', async () => {
    const calls = mockFetch(() => ({ results: [], next_cursor: null }))
    await listTodoistTasks('', 5)
    expect(calls.some((url) => new URL(url).pathname === '/api/v1/tasks')).toBe(true)
  })

  it('rejects a bad token without saving it', async () => {
    mockFetch(() => new Response('', { status: 401 }))
    expect(await connectTodoist('bad')).toEqual({
      ok: false,
      error: 'Todoist rejected the API token.'
    })
    expect(saveTodoistCredential).not.toHaveBeenCalled()
  })

  it('surfaces the Todoist error message instead of the raw JSON body', async () => {
    mockFetch(() =>
      Response.json(
        { error: 'The search query is incorrect', error_tag: 'INVALID_SEARCH_QUERY' },
        { status: 400 }
      )
    )
    await expect(listTodoistTasks('nonsense ((', 5)).rejects.toThrow(
      /^The search query is incorrect$/
    )
  })

  it('closes a task with POST', async () => {
    let method: string | undefined
    mockFetch((_url, init) => {
      method = init?.method
      return new Response(null, { status: 204 })
    })
    expect(await closeTodoistTask('t1')).toEqual({ ok: true })
    expect(method).toBe('POST')
  })
})

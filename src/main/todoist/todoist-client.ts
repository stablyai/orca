import { ensureElectronProxyFromEnvironment } from '../network/proxy-settings'
import { getMainHttpClient } from '../network/http-client'
import {
  clearTodoistCredential,
  getStoredTodoistViewer,
  getTodoistCredentialError,
  loadTodoistToken,
  saveTodoistCredential
} from './todoist-credential-store'
import { isRecord, mapTodoistComment, mapTodoistTask, mapTodoistViewer } from './todoist-mapping'
import type {
  TodoistComment,
  TodoistConnectResult,
  TodoistConnectionStatus,
  TodoistMutationResult,
  TodoistProject,
  TodoistTask
} from '../../shared/todoist/todoist-types'

const TODOIST_API_BASE = 'https://api.todoist.com/api/v1'
const PAGE_SIZE = 200
// Why: the signal also bounds body reads, so a stalled response cannot hold task results.
const REQUEST_TIMEOUT_MS = 30_000

async function todoistRequest(token: string, path: string, init?: RequestInit): Promise<unknown> {
  const url = `${TODOIST_API_BASE}${path}`
  const httpClient = getMainHttpClient()
  const proxySession = httpClient.proxySession()
  // Why: a failed proxy probe should not block the request; fetch surfaces the real error.
  await ensureElectronProxyFromEnvironment({
    ...(proxySession ? { proxySession } : {}),
    probeUrl: url
  }).catch(() => {})
  const headers = new Headers(init?.headers)
  headers.set('Accept', 'application/json')
  headers.set('Authorization', `Bearer ${token}`)
  const response = await httpClient.fetch(url, {
    ...init,
    headers,
    signal: init?.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  })
  if (!response.ok) {
    const message =
      response.status === 401 || response.status === 403
        ? 'Todoist rejected the API token.'
        : await readTodoistError(response)
    throw new Error(message)
  }
  return response.status === 204 ? null : response.json()
}

async function readTodoistError(response: Response): Promise<string> {
  const fallback = response.statusText || `Todoist request failed (${response.status})`
  const body = await response.text().catch(() => '')
  try {
    const parsed: unknown = JSON.parse(body)
    return isRecord(parsed) && typeof parsed.error === 'string' ? parsed.error : fallback
  } catch {
    return body.trim() || fallback
  }
}

async function fetchPages(token: string, path: string, limit: number): Promise<unknown[]> {
  const items: unknown[] = []
  // Why: Todoist rejects a cursor reused with different parameters, so the page size stays fixed.
  const pageSize = String(Math.min(PAGE_SIZE, limit))
  let cursor: string | null = null
  do {
    const params = new URLSearchParams({ limit: pageSize })
    if (cursor) {
      params.set('cursor', cursor)
    }
    const separator = path.includes('?') ? '&' : '?'
    const page = await todoistRequest(token, `${path}${separator}${params}`)
    const results = isRecord(page) && Array.isArray(page.results) ? page.results : []
    items.push(...results)
    const next = isRecord(page) && typeof page.next_cursor === 'string' ? page.next_cursor : null
    // Why: a repeated cursor would loop forever; an empty page with a new cursor still has more.
    cursor = next && next !== cursor ? next : null
  } while (cursor && items.length < limit)
  return items.slice(0, limit)
}

async function requireToken(): Promise<string> {
  const token = await loadTodoistToken()
  if (!token) {
    throw new Error('Todoist is not connected.')
  }
  return token
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function connectTodoist(apiToken: string): Promise<TodoistConnectResult> {
  const token = apiToken.trim()
  if (!token) {
    return { ok: false, error: 'API token is required.' }
  }
  try {
    const viewer = mapTodoistViewer(await todoistRequest(token, '/user'))
    if (!viewer) {
      return { ok: false, error: 'Todoist returned an unexpected user response.' }
    }
    await saveTodoistCredential(token, viewer)
    return { ok: true, viewer }
  } catch (error) {
    return { ok: false, error: errorMessage(error) }
  }
}

export async function disconnectTodoist(): Promise<void> {
  await clearTodoistCredential()
}

export async function getTodoistStatus(): Promise<TodoistConnectionStatus> {
  const viewer = await getStoredTodoistViewer()
  const error = getTodoistCredentialError()
  return { connected: viewer !== null, viewer, ...(error ? { error } : {}) }
}

async function listTodoistProjects(): Promise<TodoistProject[]> {
  const raw = await fetchPages(await requireToken(), '/projects', 1000)
  return raw.flatMap((item) =>
    isRecord(item) && typeof item.id === 'string' && typeof item.name === 'string'
      ? [{ id: item.id, name: item.name }]
      : []
  )
}

async function projectNames(): Promise<Map<string, string>> {
  // Why: project names are cosmetic; a failed lookup must not hide the tasks.
  const projects = await listTodoistProjects().catch((): TodoistProject[] => [])
  return new Map(projects.map((project) => [project.id, project.name]))
}

export async function listTodoistTasks(query: string, limit: number): Promise<TodoistTask[]> {
  const token = await requireToken()
  const trimmed = query.trim()
  const path = trimmed ? `/tasks/filter?${new URLSearchParams({ query: trimmed })}` : '/tasks'
  const [raw, names] = await Promise.all([fetchPages(token, path, limit), projectNames()])
  return raw.flatMap((item) => {
    const task = mapTodoistTask(item, names)
    return task ? [task] : []
  })
}

export async function getTodoistComments(taskId: string): Promise<TodoistComment[]> {
  const path = `/comments?${new URLSearchParams({ task_id: taskId })}`
  const raw = await fetchPages(await requireToken(), path, 200)
  return raw.flatMap((item) => {
    const comment = mapTodoistComment(item)
    return comment ? [comment] : []
  })
}

export async function closeTodoistTask(id: string): Promise<TodoistMutationResult> {
  try {
    await todoistRequest(await requireToken(), `/tasks/${encodeURIComponent(id)}/close`, {
      method: 'POST'
    })
    return { ok: true }
  } catch (error) {
    return { ok: false, error: errorMessage(error) }
  }
}

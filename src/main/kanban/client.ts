import {
  KANBAN_SERVER_URL,
  type KanbanConnectResult,
  type KanbanConnectionStatus,
  type KanbanRequestErrorCode,
  type KanbanTaskDetails,
  type KanbanTaskFilter,
  type KanbanTaskListResult,
  type KanbanTaskSummary
} from '../../shared/kanban-types'
import { mapKanbanTaskDetails, mapKanbanTaskList, mapKanbanViewer } from './task-mapping'
import {
  clearStoredKanbanCredential,
  getStoredKanbanCredentialError,
  getStoredKanbanMetadata,
  hasStoredKanbanCredential,
  loadStoredKanbanToken,
  saveKanbanCredential
} from './credential-store'

const DAY_MS = 86_400_000
export const KANBAN_DONE_LANE_NAME = 'Сделано'

const ERROR_MESSAGES: Record<KanbanRequestErrorCode, string> = {
  invalid_token: 'Enter a Kanban personal token.',
  unauthorized: 'Kanban authentication failed. Reconnect your token.',
  forbidden: 'Kanban access is forbidden.',
  conflict: 'The Kanban task changed on the server. Try again.',
  invalid_response: 'Kanban returned an invalid response.',
  timeout: 'The Kanban request timed out.',
  network: 'Kanban is unreachable. Check your connection.',
  server: 'Kanban server error.'
}

export class KanbanRequestError extends Error {
  constructor(
    readonly code: KanbanRequestErrorCode,
    message = ERROR_MESSAGES[code]
  ) {
    super(message)
    this.name = 'KanbanRequestError'
  }
}

export type KanbanClient = {
  connect(token: string): Promise<KanbanConnectResult>
  disconnect(): void
  getStatus(): KanbanConnectionStatus
  listTasks(filter?: KanbanTaskFilter): Promise<KanbanTaskListResult>
  getTask(id: string): Promise<KanbanTaskDetails | null>
}

export type KanbanClientOptions = {
  fetch: typeof fetch
  now?: () => number
  timeoutMs?: number
}

let authInvalidated = false

export function createKanbanClient(options: KanbanClientOptions): KanbanClient {
  const now = options.now ?? Date.now
  const timeoutMs = options.timeoutMs ?? 10_000

  async function requestJson(
    path: string,
    token: string,
    notFoundIsNull = false
  ): Promise<unknown> {
    let response: Response
    try {
      response = await options.fetch(`${KANBAN_SERVER_URL}${path}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json'
        },
        signal: AbortSignal.timeout(timeoutMs)
      })
    } catch (error) {
      if (
        error instanceof Error &&
        (error.name === 'TimeoutError' || error.name === 'AbortError')
      ) {
        throw new KanbanRequestError('timeout')
      }
      throw new KanbanRequestError('network')
    }
    if (response.status === 401) {
      authInvalidated = true
      throw new KanbanRequestError('unauthorized')
    }
    if (response.status === 403) {
      authInvalidated = true
      throw new KanbanRequestError('forbidden')
    }
    if (response.status === 409) {
      throw new KanbanRequestError('conflict')
    }
    if (response.status === 404 && notFoundIsNull) {
      return null
    }
    if (!response.ok) {
      throw new KanbanRequestError('server')
    }
    try {
      return (await response.json()) as unknown
    } catch {
      throw new KanbanRequestError('invalid_response')
    }
  }

  function requireStoredToken(): string {
    const token = loadStoredKanbanToken({ force: true })
    if (!token) {
      throw new KanbanRequestError('unauthorized')
    }
    return token
  }

  async function connect(token: string): Promise<KanbanConnectResult> {
    const trimmed = token.trim()
    if (!trimmed) {
      return { ok: false, code: 'invalid_token', error: ERROR_MESSAGES.invalid_token }
    }
    try {
      const raw = await requestJson('/api/me', trimmed)
      const mapped = mapKanbanViewer(raw)
      if (!mapped.ok) {
        return { ok: false, code: 'invalid_response', error: ERROR_MESSAGES.invalid_response }
      }
      saveKanbanCredential({ token: trimmed, viewer: mapped.value })
      authInvalidated = false
      return { ok: true, viewer: mapped.value }
    } catch (error) {
      if (error instanceof KanbanRequestError) {
        return { ok: false, code: error.code, error: error.message }
      }
      return { ok: false, code: 'network', error: ERROR_MESSAGES.network }
    }
  }

  function disconnect(): void {
    authInvalidated = false
    clearStoredKanbanCredential()
  }

  function getStatus(): KanbanConnectionStatus {
    if (authInvalidated) {
      return { connected: false, reason: 'invalid' }
    }
    const metadata = getStoredKanbanMetadata()
    if (!metadata || !hasStoredKanbanCredential()) {
      return { connected: false, reason: 'missing' }
    }
    if (getStoredKanbanCredentialError()) {
      return { connected: false, reason: 'decrypt_failed' }
    }
    return {
      connected: true,
      viewer: { id: metadata.viewerId, name: metadata.viewerName, level: metadata.viewerLevel }
    }
  }

  async function listTasks(filter?: KanbanTaskFilter): Promise<KanbanTaskListResult> {
    const token = requireStoredToken()
    const raw = await requestJson('/api/tasks', token)
    const mapped = mapKanbanTaskList(raw)
    if (!mapped.ok) {
      throw new KanbanRequestError('invalid_response')
    }
    const viewerId = getStoredKanbanMetadata()?.viewerId ?? ''
    const effectiveFilter = filter ?? { role: 'executor' as const }
    const tasks = sortKanbanTasks(
      filterKanbanTasks(mapped.value.tasks, viewerId, effectiveFilter, now)
    )
    return {
      tasks,
      lanes: mapped.value.lanes,
      receivedAt: new Date(now()).toISOString()
    }
  }

  async function getTask(id: string): Promise<KanbanTaskDetails | null> {
    const token = requireStoredToken()
    const raw = await requestJson(`/api/tasks/${encodeURIComponent(id)}`, token, true)
    if (raw === null) {
      return null
    }
    const mapped = mapKanbanTaskDetails(raw)
    if (!mapped.ok) {
      throw new KanbanRequestError('invalid_response')
    }
    return mapped.value
  }

  return { connect, disconnect, getStatus, listTasks, getTask }
}

function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

function matchesDue(
  due: string | null,
  kind: NonNullable<KanbanTaskFilter['due']>,
  todayMs: number
): boolean {
  if (kind === 'none') {
    return due === null
  }
  if (!due) {
    return false
  }
  const dueKey = due.slice(0, 10)
  const todayKey = dayKey(todayMs)
  if (kind === 'overdue') {
    return dueKey < todayKey
  }
  if (kind === 'today') {
    return dueKey === todayKey
  }
  const weekEndKey = dayKey(todayMs + 7 * DAY_MS)
  return dueKey > todayKey && dueKey <= weekEndKey
}

function isViewerInRole(
  task: KanbanTaskSummary,
  viewerId: string,
  role: KanbanTaskFilter['role']
): boolean {
  if (role === 'executor') {
    return task.executors.some((person) => person.id === viewerId)
  }
  if (role === 'observer') {
    return task.observers.some((person) => person.id === viewerId)
  }
  return task.createdBy?.id === viewerId
}

export function filterKanbanTasks(
  tasks: readonly KanbanTaskSummary[],
  viewerId: string,
  filter: KanbanTaskFilter,
  now: () => number
): KanbanTaskSummary[] {
  const includeDone = filter.includeDone ?? false
  const query = filter.query?.trim().toLowerCase() ?? ''
  return tasks.filter((task) => {
    if (!isViewerInRole(task, viewerId, filter.role)) {
      return false
    }
    if (!includeDone && task.laneName === KANBAN_DONE_LANE_NAME) {
      return false
    }
    if (filter.laneId && task.laneId !== filter.laneId) {
      return false
    }
    if (filter.urgent && !task.urgent) {
      return false
    }
    if (filter.due && !matchesDue(task.due, filter.due, now())) {
      return false
    }
    if (
      query &&
      !task.title.toLowerCase().includes(query) &&
      !task.id.toLowerCase().includes(query)
    ) {
      return false
    }
    return true
  })
}

export function sortKanbanTasks(tasks: readonly KanbanTaskSummary[]): KanbanTaskSummary[] {
  return [...tasks].sort((a, b) => {
    if (a.urgent !== b.urgent) {
      return a.urgent ? -1 : 1
    }
    const aDue = a.due ? Date.parse(a.due) : null
    const bDue = b.due ? Date.parse(b.due) : null
    // Why: the has-due vs no-due precedence applies only when exactly one side
    // carries a due date; when both have equal dues (or neither does), control
    // must reach the title comparison so ties break on the locale-aware title.
    if (aDue !== null && bDue === null) {
      return -1
    }
    if (aDue === null && bDue !== null) {
      return 1
    }
    if (aDue !== null && bDue !== null && aDue !== bDue) {
      return aDue - bDue
    }
    return a.title.localeCompare(b.title)
  })
}

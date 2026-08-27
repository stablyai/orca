import {
  KANBAN_SERVER_URL,
  type KanbanMarkStartedArgs,
  type KanbanMarkStartedResult,
  type KanbanRequestErrorCode
} from '../../shared/kanban-types'
import { KanbanRequestError } from './client'
import { invalidateKanbanAuth } from './kanban-auth-invalidation'
import { loadStoredKanbanToken } from './credential-store'
import { mapKanbanTaskList } from './task-mapping'

export const KANBAN_STARTED_LANE_NAME = 'В работе'

export const KANBAN_TASK_NOT_FOUND_MESSAGE = 'The Kanban task could not be found on the board.'
export const KANBAN_STARTED_LANE_MISSING_MESSAGE = 'The board has no lane named "В работе".'

export type KanbanMarkStartedDeps = {
  fetch: typeof fetch
  timeoutMs?: number
}

const RESULT_CODE: Record<
  KanbanRequestErrorCode,
  Extract<KanbanMarkStartedResult, { ok: false }>['code']
> = {
  invalid_token: 'unauthorized',
  unauthorized: 'unauthorized',
  forbidden: 'unauthorized',
  conflict: 'conflict',
  invalid_response: 'invalid_response',
  timeout: 'network',
  network: 'network',
  server: 'server'
}

// Why: workspace and branch names are untrusted renderer data destined for the
// board comment; a newline must not inject extra comment lines.
function sanitizeForComment(value: string): string {
  return value.replace(/\r\n|\r|\n/g, ' ').trim()
}

export function buildKanbanStartedComment(projectName: string, branch: string | null): string {
  const project = sanitizeForComment(projectName)
  const branchText = branch ? `ветка ${sanitizeForComment(branch)}` : 'ветка без Git'
  return `Orca: начата работа — проект ${project}, ${branchText}.`
}

function toFailure(
  error: unknown,
  moved: boolean,
  commented: boolean,
  retry: 'all' | 'comment-only'
): KanbanMarkStartedResult {
  if (error instanceof KanbanRequestError) {
    return {
      ok: false,
      moved,
      commented,
      retry,
      code: RESULT_CODE[error.code],
      message: error.message
    }
  }
  return {
    ok: false,
    moved,
    commented,
    retry,
    code: 'network',
    message: new KanbanRequestError('network').message
  }
}

async function requestJson(
  fetchFn: typeof fetch,
  path: string,
  token: string,
  timeoutMs: number,
  init?: { method?: 'GET' | 'POST'; body?: unknown }
): Promise<unknown> {
  let response: Response
  try {
    response = await fetchFn(`${KANBAN_SERVER_URL}${path}`, {
      method: init?.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(init?.body !== undefined ? { 'Content-Type': 'application/json' } : {})
      },
      ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      signal: AbortSignal.timeout(timeoutMs)
    })
  } catch (error) {
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      throw new KanbanRequestError('timeout')
    }
    throw new KanbanRequestError('network')
  }
  if (response.status === 401) {
    invalidateKanbanAuth()
    throw new KanbanRequestError('unauthorized')
  }
  if (response.status === 403) {
    invalidateKanbanAuth()
    throw new KanbanRequestError('forbidden')
  }
  if (response.status === 409) {
    throw new KanbanRequestError('conflict')
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

async function readTaskAndLane(args: {
  taskId: string
  token: string
  timeoutMs: number
  fetchFn: typeof fetch
}): Promise<
  | { ok: true; taskId: string; taskVersion: number; currentLaneId: string; targetLaneId: string }
  | { ok: false; failure: KanbanMarkStartedResult }
> {
  const { taskId, token, timeoutMs, fetchFn } = args
  let mapped
  try {
    const raw = await requestJson(fetchFn, '/api/tasks', token, timeoutMs)
    const result = mapKanbanTaskList(raw)
    if (!result.ok) {
      throw new KanbanRequestError('invalid_response')
    }
    mapped = result.value
  } catch (error) {
    return { ok: false, failure: toFailure(error, false, false, 'all') }
  }
  const task = mapped.tasks.find((candidate) => candidate.id === taskId)
  if (!task) {
    return {
      ok: false,
      failure: {
        ok: false,
        moved: false,
        commented: false,
        retry: 'all',
        code: 'server',
        message: KANBAN_TASK_NOT_FOUND_MESSAGE
      }
    }
  }
  const targetLane = mapped.lanes.find((lane) => lane.name === KANBAN_STARTED_LANE_NAME)
  if (!targetLane) {
    return {
      ok: false,
      failure: {
        ok: false,
        moved: false,
        commented: false,
        retry: 'all',
        code: 'server',
        message: KANBAN_STARTED_LANE_MISSING_MESSAGE
      }
    }
  }
  return {
    ok: true,
    taskId,
    taskVersion: task.taskVersion,
    currentLaneId: task.laneId,
    targetLaneId: targetLane.id
  }
}

async function moveOnce(args: {
  taskId: string
  laneId: string
  taskVersion: number
  token: string
  timeoutMs: number
  fetchFn: typeof fetch
}): Promise<void> {
  await requestJson(
    args.fetchFn,
    `/api/tasks/${encodeURIComponent(args.taskId)}/move`,
    args.token,
    args.timeoutMs,
    {
      method: 'POST',
      body: { lane: args.laneId, task_version: args.taskVersion }
    }
  )
}

async function postComment(args: {
  taskId: string
  text: string
  token: string
  timeoutMs: number
  fetchFn: typeof fetch
}): Promise<void> {
  await requestJson(
    args.fetchFn,
    `/api/tasks/${encodeURIComponent(args.taskId)}/comments`,
    args.token,
    args.timeoutMs,
    {
      method: 'POST',
      body: { text: args.text }
    }
  )
}

/**
 * Mark a Kanban card started after Orca created and activated its workspace:
 * the main process re-reads the board, moves the card into the `В работе` lane
 * (once, with one optimistic-lock retry on 409), then adds the technical
 * comment. The renderer never supplies a lane id or task version.
 */
export async function markKanbanTaskStarted(
  args: KanbanMarkStartedArgs,
  deps: KanbanMarkStartedDeps
): Promise<KanbanMarkStartedResult> {
  const timeoutMs = deps.timeoutMs ?? 10_000
  const retry = args.retry ?? 'all'
  const token = loadStoredKanbanToken({ force: true })
  if (!token) {
    return toFailure(new KanbanRequestError('unauthorized'), false, false, retry)
  }

  // Why: a comment-only retry already moved the card — only the comment is
  // retried, with no task-list GET and no move.
  if (retry === 'comment-only') {
    try {
      await postComment({
        taskId: args.taskId,
        text: buildKanbanStartedComment(args.projectName, args.branch),
        token,
        timeoutMs,
        fetchFn: deps.fetch
      })
      return { ok: true, moved: false, commented: true }
    } catch (error) {
      return toFailure(error, false, false, 'comment-only')
    }
  }

  const read = await readTaskAndLane({
    taskId: args.taskId,
    token,
    timeoutMs,
    fetchFn: deps.fetch
  })
  if (!read.ok) {
    return read.failure
  }

  let moved = false
  if (read.currentLaneId !== read.targetLaneId) {
    try {
      await moveOnce({
        taskId: read.taskId,
        laneId: read.targetLaneId,
        taskVersion: read.taskVersion,
        token,
        timeoutMs,
        fetchFn: deps.fetch
      })
      moved = true
    } catch (error) {
      if (!(error instanceof KanbanRequestError) || error.code !== 'conflict') {
        return toFailure(error, false, false, retry)
      }
      // Why: exactly one optimistic-lock retry — reread the task for the new
      // version, then repeat the move once; a second 409 stays a conflict.
      const reread = await readTaskAndLane({
        taskId: args.taskId,
        token,
        timeoutMs,
        fetchFn: deps.fetch
      })
      if (!reread.ok) {
        return reread.failure
      }
      try {
        await moveOnce({
          taskId: reread.taskId,
          laneId: reread.targetLaneId,
          taskVersion: reread.taskVersion,
          token,
          timeoutMs,
          fetchFn: deps.fetch
        })
        moved = true
      } catch (retryError) {
        return toFailure(retryError, false, false, retry)
      }
    }
  }

  try {
    await postComment({
      taskId: read.taskId,
      text: buildKanbanStartedComment(args.projectName, args.branch),
      token,
      timeoutMs,
      fetchFn: deps.fetch
    })
    return { ok: true, moved, commented: true }
  } catch (error) {
    // Why: a moved card is never rolled back — retry resumes with comment-only.
    return toFailure(error, moved, false, 'comment-only')
  }
}

import type {
  VoloBoard,
  VoloCreateTaskArgs,
  VoloCreateTaskResult,
  VoloMember,
  VoloMutationResult,
  VoloTask,
  VoloTaskFilter,
  VoloTaskUpdate
} from '../../shared/volo-types'
import { isVoloNotFoundError, voloRequest } from './authenticated-request'
import { ensureActiveCredentials, getStatus } from './client'
import { flattenCrossBoardKanban, mapVoloBoard, mapVoloMember, mapVoloTask } from './mapping'

async function requireCredentials(): Promise<{ apiUrl: string; webUrl: string; token: string }> {
  const credentials = await ensureActiveCredentials()
  if (!credentials) {
    throw new Error('Volo is not connected.')
  }
  return credentials
}

async function loadMembers(
  apiUrl: string,
  token: string,
  boardId: string
): Promise<Map<string, VoloMember>> {
  const payload = await voloRequest(apiUrl, token, `/api/tasks/boards/${boardId}/members`)
  const rows = Array.isArray(payload) ? payload : []
  const members = new Map<string, VoloMember>()
  for (const row of rows) {
    const member = mapVoloMember(row)
    if (member) {
      members.set(member.id, member)
    }
  }
  return members
}

async function loadBoardWithTasks(boardId: string): Promise<{
  board: VoloBoard
  tasks: VoloTask[]
  members: VoloMember[]
}> {
  const { apiUrl, webUrl, token } = await requireCredentials()
  const payload = (await voloRequest(apiUrl, token, `/api/tasks/boards/${boardId}`)) as Record<
    string,
    unknown
  >
  const board = mapVoloBoard(payload)
  if (!board) {
    throw new Error('Volo board was not found.')
  }
  const membersById = await loadMembers(apiUrl, token, board.id)
  const rawTasks = Array.isArray(payload.tasks) ? payload.tasks : []
  const tasks = rawTasks
    .map((task) => mapVoloTask(task, board, webUrl, membersById))
    .filter((task): task is VoloTask => task !== null)
  return { board, tasks, members: [...membersById.values()] }
}

export async function listBoards(): Promise<VoloBoard[]> {
  const { apiUrl, token } = await requireCredentials()
  const payload = await voloRequest(apiUrl, token, '/api/tasks/boards')
  const rows = Array.isArray(payload) ? payload : []
  return rows.map((row) => mapVoloBoard(row)).filter((board): board is VoloBoard => board !== null)
}

export async function listMembers(boardId: string): Promise<VoloMember[]> {
  const { apiUrl, token } = await requireCredentials()
  const members = await loadMembers(apiUrl, token, boardId)
  return [...members.values()]
}

async function listAssignedTasks(): Promise<VoloTask[]> {
  const { apiUrl, webUrl, token } = await requireCredentials()
  const payload = await voloRequest(apiUrl, token, '/api/cross-board/kanban?includeDone=true')
  return flattenCrossBoardKanban(payload, webUrl)
}

export async function listTasks(
  boardId: string,
  filter: VoloTaskFilter = 'all'
): Promise<VoloTask[]> {
  if (filter === 'assigned') {
    try {
      return await listAssignedTasks()
    } catch (error) {
      if (!isVoloNotFoundError(error) || !boardId) {
        throw error
      }
    }
  }
  if (!boardId) {
    return []
  }
  const { board, tasks, members } = await loadBoardWithTasks(boardId)
  return filterTasks(tasks, board, filter, getStatus().viewer?.id ?? null, members)
}

export function filterTasks(
  tasks: readonly VoloTask[],
  board: VoloBoard,
  filter: VoloTaskFilter,
  viewerUserId: string | null,
  members: readonly VoloMember[] = []
): VoloTask[] {
  const memberIdsForViewer = new Set(
    members.filter((member) => member.userId === viewerUserId).map((member) => member.id)
  )
  const doneColumnIds = new Set(
    board.columns.filter((column) => column.type === 'done').map((column) => column.id)
  )
  return tasks.filter((task) => {
    if (filter === 'done') {
      return doneColumnIds.has(task.columnId)
    }
    if (filter === 'assigned') {
      return Boolean(
        task.assigneeId &&
        (memberIdsForViewer.has(task.assigneeId) ||
          (viewerUserId !== null && task.assigneeId === viewerUserId))
      )
    }
    return !doneColumnIds.has(task.columnId)
  })
}

export async function getTask(taskCode: string): Promise<VoloTask | null> {
  const { apiUrl, webUrl, token } = await requireCredentials()
  let payload: Record<string, unknown>
  try {
    payload = (await voloRequest(
      apiUrl,
      token,
      `/api/tasks/task/${encodeURIComponent(taskCode.toUpperCase())}`
    )) as Record<string, unknown>
  } catch (error) {
    if (isVoloNotFoundError(error)) {
      return null
    }
    throw error
  }
  const board = mapVoloBoard(payload.board) ?? mapVoloBoard(payload)
  const taskPayload = payload.task ?? payload
  if (!board) {
    return mapVoloTask(
      taskPayload,
      {
        id: '',
        name: '',
        prefix: '',
        columns: []
      },
      webUrl,
      new Map()
    )
  }
  const members = await loadMembers(apiUrl, token, board.id)
  return mapVoloTask(taskPayload, board, webUrl, members)
}

export async function createTask(args: VoloCreateTaskArgs): Promise<VoloCreateTaskResult> {
  try {
    const { apiUrl, webUrl, token } = await requireCredentials()
    const created = (await voloRequest(apiUrl, token, `/api/tasks/boards/${args.boardId}/tasks`, {
      method: 'POST',
      body: JSON.stringify({
        title: args.title,
        columnId: args.columnId,
        ...(args.description ? { description: args.description } : {}),
        ...(args.priority ? { priority: args.priority } : {}),
        ...(args.assigneeId ? { assignee: args.assigneeId } : {}),
        inKanban: true
      })
    })) as Record<string, unknown>
    const taskCode = typeof created.taskCode === 'string' ? created.taskCode : ''
    const id = typeof created.id === 'string' ? created.id : ''
    if (!id || !taskCode) {
      return { ok: false, error: 'Volo did not return the created task.' }
    }
    return { ok: true, id, taskCode, url: `${webUrl.replace(/\/+$/, '')}/t/${taskCode}` }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Could not create the task.'
    }
  }
}

export async function updateTask(
  boardId: string,
  taskId: string,
  updates: VoloTaskUpdate
): Promise<VoloMutationResult> {
  try {
    const { apiUrl, token } = await requireCredentials()
    await voloRequest(apiUrl, token, `/api/tasks/boards/${boardId}/tasks/${taskId}`, {
      method: 'PUT',
      body: JSON.stringify({
        ...(updates.title !== undefined ? { title: updates.title } : {}),
        ...(updates.description !== undefined ? { description: updates.description } : {}),
        ...(updates.priority !== undefined ? { priority: updates.priority } : {}),
        ...(updates.assigneeId !== undefined ? { assignee: updates.assigneeId } : {})
      })
    })
    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Could not update the task.'
    }
  }
}

export async function moveTask(
  boardId: string,
  taskId: string,
  columnId: string
): Promise<VoloMutationResult> {
  try {
    const { apiUrl, token } = await requireCredentials()
    await voloRequest(apiUrl, token, `/api/tasks/boards/${boardId}/tasks/${taskId}/move`, {
      method: 'PUT',
      body: JSON.stringify({ columnId })
    })
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Could not move the task.' }
  }
}

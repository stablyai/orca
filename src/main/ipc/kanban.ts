import { ipcMain } from 'electron'
import { KanbanRequestError, createKanbanClient, type KanbanClient } from '../kanban/client'
import { markKanbanTaskStarted } from '../kanban/mark-started'
import type {
  KanbanConnectResult,
  KanbanConnectionStatus,
  KanbanMarkStartedArgs,
  KanbanMarkStartedResult,
  KanbanTaskDetails,
  KanbanTaskFilter,
  KanbanTaskListResult
} from '../../shared/kanban-types'

// Why: the renderer must not drive arbitrary headers, URLs, HTTP methods or
// fetch options — this boundary accepts only the narrow normalized fields a
// Kanban operation needs, with bounded string lengths.
const MAX_TOKEN_LENGTH = 4096
const MAX_TASK_ID_LENGTH = 512
const MAX_LANE_ID_LENGTH = 128
const MAX_QUERY_LENGTH = 256
const MAX_PROJECT_NAME_LENGTH = 256
const MAX_BRANCH_LENGTH = 256
const VALID_ROLES = new Set(['executor', 'observer', 'creator'])
const VALID_DUE = new Set(['overdue', 'today', 'week', 'none'])

let client: KanbanClient | null = null

function getClient(): KanbanClient {
  if (!client) {
    client = createKanbanClient({ fetch: globalThis.fetch })
  }
  return client
}

function readField(value: unknown, key: string): unknown {
  if (value === null || typeof value !== 'object') {
    return undefined
  }
  return (value as Record<string, unknown>)[key]
}

function normalizeFilter(value: unknown): KanbanTaskFilter | undefined | null {
  if (value === undefined) {
    return undefined
  }
  if (value === null || typeof value !== 'object') {
    return null
  }
  const raw = value as Record<string, unknown>
  if (typeof raw.role !== 'string' || !VALID_ROLES.has(raw.role as KanbanTaskFilter['role'])) {
    return null
  }
  if (raw.laneId !== undefined) {
    if (
      typeof raw.laneId !== 'string' ||
      raw.laneId.trim().length === 0 ||
      raw.laneId.length > MAX_LANE_ID_LENGTH
    ) {
      return null
    }
  }
  if (raw.due !== undefined && (typeof raw.due !== 'string' || !VALID_DUE.has(raw.due))) {
    return null
  }
  if (raw.urgent !== undefined && typeof raw.urgent !== 'boolean') {
    return null
  }
  if (raw.includeDone !== undefined && typeof raw.includeDone !== 'boolean') {
    return null
  }
  if (
    raw.query !== undefined &&
    (typeof raw.query !== 'string' || raw.query.length > MAX_QUERY_LENGTH)
  ) {
    return null
  }
  const filter: KanbanTaskFilter = { role: raw.role as KanbanTaskFilter['role'] }
  if (raw.laneId !== undefined) {
    filter.laneId = raw.laneId as string
  }
  if (raw.due !== undefined) {
    filter.due = raw.due as KanbanTaskFilter['due']
  }
  if (raw.urgent !== undefined) {
    filter.urgent = raw.urgent as boolean
  }
  if (raw.includeDone !== undefined) {
    filter.includeDone = raw.includeDone as boolean
  }
  if (raw.query !== undefined) {
    filter.query = raw.query as string
  }
  return filter
}

export function registerKanbanHandlers(): void {
  ipcMain.handle('kanban:connect', async (_event, args: unknown): Promise<KanbanConnectResult> => {
    const token = readField(args, 'token')
    if (typeof token !== 'string' || token.trim().length === 0 || token.length > MAX_TOKEN_LENGTH) {
      return {
        ok: false,
        code: 'invalid_token',
        error: new KanbanRequestError('invalid_token').message
      }
    }
    return getClient().connect(token.trim())
  })

  ipcMain.handle('kanban:disconnect', async (): Promise<void> => {
    getClient().disconnect()
  })

  ipcMain.handle('kanban:status', async (): Promise<KanbanConnectionStatus> => {
    return getClient().getStatus()
  })

  ipcMain.handle(
    'kanban:listTasks',
    async (_event, args: unknown): Promise<KanbanTaskListResult> => {
      if (args !== undefined && (args === null || typeof args !== 'object')) {
        throw new Error('Invalid Kanban task filter.')
      }
      const filter = normalizeFilter(readField(args, 'filter'))
      if (filter === null) {
        throw new Error('Invalid Kanban task filter.')
      }
      return getClient().listTasks(filter)
    }
  )

  ipcMain.handle(
    'kanban:getTask',
    async (_event, args: unknown): Promise<KanbanTaskDetails | null> => {
      const id = readField(args, 'id')
      if (typeof id !== 'string' || id.trim().length === 0 || id.length > MAX_TASK_ID_LENGTH) {
        return null
      }
      return getClient().getTask(id.trim())
    }
  )

  ipcMain.handle(
    'kanban:markStarted',
    async (_event, args: unknown): Promise<KanbanMarkStartedResult> => {
      const invalid = (retry: 'all' | 'comment-only'): KanbanMarkStartedResult => ({
        ok: false,
        moved: false,
        commented: false,
        retry,
        code: 'server',
        message: 'Invalid Kanban mark-started request.'
      })
      const taskId = readField(args, 'taskId')
      const projectName = readField(args, 'projectName')
      const branch = readField(args, 'branch')
      const retry = readField(args, 'retry')
      if (
        typeof taskId !== 'string' ||
        taskId.trim().length === 0 ||
        taskId.length > MAX_TASK_ID_LENGTH
      ) {
        return invalid('all')
      }
      if (
        typeof projectName !== 'string' ||
        projectName.trim().length === 0 ||
        projectName.length > MAX_PROJECT_NAME_LENGTH
      ) {
        return invalid('all')
      }
      if (
        branch !== undefined &&
        branch !== null &&
        (typeof branch !== 'string' || branch.length > MAX_BRANCH_LENGTH)
      ) {
        return invalid('all')
      }
      if (
        retry !== undefined &&
        retry !== 'all' &&
        retry !== 'comment-only'
      ) {
        return invalid(retry === 'comment-only' ? 'comment-only' : 'all')
      }
      const markArgs: KanbanMarkStartedArgs = {
        taskId: taskId.trim(),
        projectName: projectName.trim(),
        branch: typeof branch === 'string' ? branch : null
      }
      if (retry === 'all' || retry === 'comment-only') {
        markArgs.retry = retry
      }
      return markKanbanTaskStarted(markArgs, { fetch: globalThis.fetch })
    }
  )
}

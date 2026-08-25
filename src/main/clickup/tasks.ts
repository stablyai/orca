import type { ClickUpCreateTaskArgs, ClickUpCreateTaskResult, ClickUpMutationResult, ClickUpTask, ClickUpTaskFilter, ClickUpTaskUpdate, ClickUpWorkspaceSelection } from '../../shared/clickup-types'
import {
  ClickUpApiError,
  clickUpRequest,
  getStatus,
  requireClickUpClient,
  requireClickUpClients,
  type ClickUpClientForWorkspace
} from './client'
import { dueDateToTimestamp, normalizeClickUpTask, type JsonRecord } from './task-mapping'

export {
  listClickUpLists as listLists,
  listClickUpWorkspaceMembers as listWorkspaceMembers,
  listClickUpWorkspaceTags as listWorkspaceTags
} from './workspace-directory'
export {
  addClickUpTaskComment as addTaskComment,
  getClickUpTaskComments as getTaskComments
} from './task-comments'

const TASK_PAGE_SIZE = 100
const MAX_SEARCH_PAGES = 10

function queryForTaskPage(
  page: number,
  filter: ClickUpTaskFilter,
  viewerId: number | undefined
): string {
  const query = new URLSearchParams({
    page: String(page),
    order_by: 'updated',
    reverse: 'true',
    subtasks: 'true',
    include_markdown_description: 'true',
    include_closed: filter === 'completed' || filter === 'all' ? 'true' : 'false'
  })
  if (filter === 'assigned' && viewerId !== undefined) {
    query.append('assignees[]', String(viewerId))
  }
  return query.toString()
}

function matchesClientFilter(
  task: ClickUpTask,
  filter: ClickUpTaskFilter,
  viewerId: number | undefined
): boolean {
  if (filter === 'created') {
    return viewerId !== undefined && task.creator?.id === viewerId
  }
  if (filter === 'completed') {
    return task.status.type === 'closed' || task.closedAt !== null
  }
  if (filter === 'open') {
    return task.status.type !== 'closed' && task.closedAt === null
  }
  return true
}

async function getWorkspaceTaskPage(
  client: ClickUpClientForWorkspace,
  page: number,
  filter: ClickUpTaskFilter
): Promise<{ rawCount: number; tasks: ClickUpTask[] }> {
  const viewerId = getStatus().viewer?.id
  const query = queryForTaskPage(page, filter, viewerId)
  const response = await clickUpRequest<{ tasks?: unknown[] }>(
    client,
    `/team/${encodeURIComponent(client.workspace.id)}/task?${query}`
  )
  const rawTasks = response.tasks ?? []
  return {
    rawCount: rawTasks.length,
    tasks: rawTasks
      .map((task) => normalizeClickUpTask(task, client))
      .filter((task): task is ClickUpTask => task !== null)
      .filter((task) => matchesClientFilter(task, filter, viewerId))
  }
}

async function listWorkspaceTasks(
  client: ClickUpClientForWorkspace,
  filter: ClickUpTaskFilter,
  limit: number
): Promise<ClickUpTask[]> {
  const matches: ClickUpTask[] = []
  for (let page = 0; page < MAX_SEARCH_PAGES && matches.length < limit; page += 1) {
    const result = await getWorkspaceTaskPage(client, page, filter)
    matches.push(...result.tasks)
    if (result.rawCount < TASK_PAGE_SIZE) {
      break
    }
  }
  return matches
}

export async function listTasks(
  filter: ClickUpTaskFilter = 'assigned',
  limit = 50,
  workspaceId?: ClickUpWorkspaceSelection | null
): Promise<ClickUpTask[]> {
  const safeLimit = Math.min(Math.max(1, limit), TASK_PAGE_SIZE)
  const results = await Promise.all(
    requireClickUpClients(workspaceId).map((client) =>
      listWorkspaceTasks(client, filter, safeLimit)
    )
  )
  return results
    .flat()
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, safeLimit)
}

export async function searchTasks(
  query: string,
  limit = 20,
  workspaceId?: ClickUpWorkspaceSelection | null
): Promise<ClickUpTask[]> {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) {
    return []
  }
  const safeLimit = Math.min(Math.max(1, limit), 50)
  const matches = await Promise.all(
    requireClickUpClients(workspaceId).map(async (client) => {
      const workspaceMatches: ClickUpTask[] = []
      for (
        let page = 0;
        page < MAX_SEARCH_PAGES && workspaceMatches.length < safeLimit;
        page += 1
      ) {
        const result = await getWorkspaceTaskPage(client, page, 'all')
        workspaceMatches.push(
          ...result.tasks.filter((task) =>
            [task.id, task.customId, task.name, task.description]
              .filter((value): value is string => Boolean(value))
              .some((value) => value.toLocaleLowerCase().includes(needle))
          )
        )
        if (result.rawCount < TASK_PAGE_SIZE) {
          break
        }
      }
      return workspaceMatches
    })
  )
  return matches
    .flat()
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, safeLimit)
}

export async function getTask(taskId: string, workspaceId?: string): Promise<ClickUpTask | null> {
  const clients = workspaceId ? [requireClickUpClient(workspaceId)] : requireClickUpClients()
  for (const client of clients) {
    try {
      const response = await clickUpRequest<unknown>(
        client,
        `/task/${encodeURIComponent(taskId)}?include_subtasks=true&include_markdown_description=true`
      )
      const task = normalizeClickUpTask(response, client)
      if (task) {
        return task
      }
    } catch (error) {
      if (error instanceof ClickUpApiError && error.status === 404) {
        continue
      }
      throw error
    }
  }
  return null
}

function createTaskBody(args: ClickUpCreateTaskArgs): JsonRecord {
  return {
    name: args.name,
    ...(args.description ? { markdown_content: args.description } : {}),
    ...(args.status ? { status: args.status } : {}),
    ...(args.priority !== undefined ? { priority: args.priority } : {}),
    ...(args.dueDate ? { due_date: dueDateToTimestamp(args.dueDate) } : {}),
    ...(args.timeEstimate !== undefined ? { time_estimate: args.timeEstimate } : {}),
    ...(args.assigneeIds ? { assignees: args.assigneeIds } : {}),
    ...(args.tagNames ? { tags: args.tagNames } : {}),
    ...(args.parentTaskId ? { parent: args.parentTaskId } : {})
  }
}

export async function createTask(args: ClickUpCreateTaskArgs): Promise<ClickUpCreateTaskResult> {
  try {
    const client = requireClickUpClient(args.workspaceId)
    const response = await clickUpRequest<unknown>(
      client,
      `/list/${encodeURIComponent(args.listId)}/task`,
      {
        method: 'POST',
        body: JSON.stringify(createTaskBody(args))
      }
    )
    const task = normalizeClickUpTask(response, client)
    return task
      ? { ok: true, task }
      : { ok: false, error: 'ClickUp created the task but returned an invalid response.' }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Task creation failed.' }
  }
}

function updateTaskBody(updates: ClickUpTaskUpdate, current: ClickUpTask): JsonRecord {
  const currentAssigneeIds = new Set(current.assignees.map((assignee) => assignee.id))
  const nextAssigneeIds = new Set(updates.assigneeIds ?? currentAssigneeIds)
  return {
    ...(updates.name !== undefined ? { name: updates.name } : {}),
    ...(updates.description !== undefined ? { markdown_content: updates.description || ' ' } : {}),
    ...(updates.status !== undefined ? { status: updates.status } : {}),
    ...(updates.priority !== undefined ? { priority: updates.priority } : {}),
    ...(updates.dueDate !== undefined
      ? { due_date: updates.dueDate === null ? null : dueDateToTimestamp(updates.dueDate) }
      : {}),
    ...(updates.timeEstimate !== undefined ? { time_estimate: updates.timeEstimate } : {}),
    ...(updates.assigneeIds !== undefined
      ? {
          assignees: {
            add: [...nextAssigneeIds].filter((id) => !currentAssigneeIds.has(id)),
            rem: [...currentAssigneeIds].filter((id) => !nextAssigneeIds.has(id))
          }
        }
      : {})
  }
}

async function updateTags(
  client: ClickUpClientForWorkspace,
  task: ClickUpTask,
  tagNames: string[]
): Promise<void> {
  const current = new Set(task.tags.map((tag) => tag.name))
  const next = new Set(tagNames)
  const changes = [
    ...[...next]
      .filter((tag) => !current.has(tag))
      .map((tag) => ({
        description: `add "${tag}"`,
        request: clickUpRequest(
          client,
          `/task/${encodeURIComponent(task.id)}/tag/${encodeURIComponent(tag)}`,
          { method: 'POST' }
        )
      })),
    ...[...current]
      .filter((tag) => !next.has(tag))
      .map((tag) => ({
        description: `remove "${tag}"`,
        request: clickUpRequest(
          client,
          `/task/${encodeURIComponent(task.id)}/tag/${encodeURIComponent(tag)}`,
          { method: 'DELETE' }
        )
      }))
  ]
  const results = await Promise.allSettled(changes.map((change) => change.request))
  const failures = results.flatMap((result, index) =>
    result.status === 'rejected' ? [changes[index]!.description] : []
  )
  if (failures.length > 0) {
    throw new Error(`ClickUp could not ${failures.join(', ')}.`)
  }
}

export async function updateTask(
  taskId: string,
  updates: ClickUpTaskUpdate,
  workspaceId?: string
): Promise<ClickUpMutationResult> {
  try {
    const client = requireClickUpClient(workspaceId)
    const current = await getTask(taskId, client.workspace.id)
    if (!current) {
      return { ok: false, error: 'ClickUp task not found.' }
    }
    const body = updateTaskBody(updates, current)
    if (Object.keys(body).length > 0) {
      await clickUpRequest(client, `/task/${encodeURIComponent(taskId)}`, {
        method: 'PUT',
        body: JSON.stringify(body)
      })
    }
    if (updates.tagNames !== undefined) {
      await updateTags(client, current, updates.tagNames)
    }
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Task update failed.' }
  }
}

import { CLICKUP_CUSTOM_TASK_ID_PATTERN } from '../../shared/clickup-task-url'
import type { ClickUpTask } from '../../shared/clickup-types'
import {
  ClickUpApiError,
  clickUpRequest,
  requireClickUpClient,
  requireClickUpClients,
  type ClickUpClientForWorkspace
} from './client'
import { normalizeClickUpTask } from './task-mapping'

function taskLookupPath(taskId: string, client: ClickUpClientForWorkspace): string {
  const query = new URLSearchParams({
    include_subtasks: 'true',
    include_markdown_description: 'true'
  })
  // Why: ClickUp only resolves a custom id ("CHP-7616") when told to, and then
  // needs the Workspace it belongs to.
  if (CLICKUP_CUSTOM_TASK_ID_PATTERN.test(taskId)) {
    query.set('custom_task_ids', 'true')
    query.set('team_id', client.workspace.id)
  }
  return `/task/${encodeURIComponent(taskId)}?${query.toString()}`
}

// 404 means "not here"; 401/400 are how ClickUp answers ids from another
// Workspace or malformed ids, so lookups across Workspaces skip them too.
function isTaskMissError(error: unknown): boolean {
  return (
    error instanceof ClickUpApiError &&
    (error.status === 404 || error.status === 400 || error.status === 401)
  )
}

export async function getClickUpTaskInWorkspace(
  client: ClickUpClientForWorkspace,
  taskId: string,
  options: { tolerateMisses: boolean }
): Promise<ClickUpTask | null> {
  try {
    const response = await clickUpRequest<unknown>(client, taskLookupPath(taskId, client))
    return normalizeClickUpTask(response, client)
  } catch (error) {
    const missed = options.tolerateMisses
      ? isTaskMissError(error)
      : error instanceof ClickUpApiError && error.status === 404
    if (missed) {
      return null
    }
    throw error
  }
}

// Reads one task by native id or custom id (e.g. "CHP-7616").
export async function getClickUpTask(
  taskId: string,
  workspaceId?: string
): Promise<ClickUpTask | null> {
  const clients = workspaceId ? [requireClickUpClient(workspaceId)] : requireClickUpClients()
  for (const client of clients) {
    const task = await getClickUpTaskInWorkspace(client, taskId, { tolerateMisses: false })
    if (task) {
      return task
    }
  }
  return null
}

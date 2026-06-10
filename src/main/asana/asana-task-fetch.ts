import type { AsanaTask, AsanaTaskFilter, AsanaWorkspaceSelection } from '../../shared/types'
import {
  acquire,
  asanaRequest,
  AsanaApiError,
  clearToken,
  isAuthError,
  isSearchUnavailable,
  markSearchUnavailable,
  release,
  type AsanaClientForWorkspace
} from './client'
import {
  mapAsanaTask,
  shouldThrowAuthError,
  TASK_FIELDS,
  type AsanaListResponse
} from './asana-task-mapping'

export async function fetchTasksForClient(
  entry: AsanaClientForWorkspace,
  filter: AsanaTaskFilter,
  limit: number,
  projectId?: string | null
): Promise<AsanaTask[]> {
  const params = new URLSearchParams({
    opt_fields: TASK_FIELDS,
    limit: String(Math.min(100, Math.max(limit, 20)))
  })
  // Why: /tasks scopes by `project` OR `assignee`+`workspace`, not both, and the
  // free tier can't intersect them. A project filter therefore lists the whole
  // project (all assignees); the default view stays the caller's assigned tasks.
  if (projectId) {
    params.set('project', projectId)
  } else {
    params.set('assignee', 'me')
    params.set('workspace', entry.workspace.id)
  }
  // Why: Asana has no "completed only" REST filter outside the premium search
  // API. `completed_since=now` returns only incomplete tasks; for `done`/`all`
  // we fetch the full set and filter client-side.
  if (filter === 'assigned') {
    params.set('completed_since', 'now')
  }
  const response = await asanaRequest<AsanaListResponse>(entry, `/tasks?${params.toString()}`)
  const tasks = (response.data ?? []).map((task) => mapAsanaTask(entry.workspace, task))
  if (filter === 'done') {
    return tasks.filter((task) => task.completed)
  }
  return tasks
}

// Why: the premium search endpoint sorts server-side (modified_at desc) so it
// returns the genuinely most-recent top-N when tasks exceed one page, and it can
// intersect assignee + project. The /tasks list can do neither. Prefer search
// for "my tasks", falling back to /tasks on the free tier (402) and remembering
// the verdict per workspace so we probe premium only once.
export async function fetchMyTasks(
  entry: AsanaClientForWorkspace,
  filter: AsanaTaskFilter,
  limit: number,
  projectId?: string | null
): Promise<AsanaTask[]> {
  if (isSearchUnavailable(entry.workspace.id)) {
    return fetchTasksForClient(entry, filter, limit, projectId)
  }
  try {
    const params = new URLSearchParams({
      opt_fields: TASK_FIELDS,
      limit: String(limit),
      sort_by: 'modified_at',
      sort_ascending: 'false',
      'assignee.any': 'me'
    })
    if (projectId) {
      params.set('projects.any', projectId)
    }
    if (filter === 'assigned') {
      params.set('completed', 'false')
    } else if (filter === 'done') {
      params.set('completed', 'true')
    }
    const response = await asanaRequest<AsanaListResponse>(
      entry,
      `/workspaces/${encodeURIComponent(entry.workspace.id)}/tasks/search?${params.toString()}`
    )
    return (response.data ?? []).map((task) => mapAsanaTask(entry.workspace, task))
  } catch (error) {
    if (error instanceof AsanaApiError && error.status === 402) {
      markSearchUnavailable(entry.workspace.id)
      return fetchTasksForClient(entry, filter, limit, projectId)
    }
    throw error
  }
}

// Why: free-tier fallback for the premium-only search endpoint — fetch the
// assigned task set and match titles client-side.
export async function filterTasksLocally(
  entry: AsanaClientForWorkspace,
  text: string
): Promise<AsanaTask[]> {
  const tasks = await fetchTasksForClient(entry, 'all', 100)
  const lowered = text.toLowerCase()
  return tasks.filter((task) => task.title.toLowerCase().includes(lowered))
}

export async function fanOut<T>(
  entries: AsanaClientForWorkspace[],
  selection: AsanaWorkspaceSelection | null | undefined,
  label: string,
  run: (entry: AsanaClientForWorkspace) => Promise<T[]>
): Promise<T[][]> {
  return Promise.all(
    entries.map(async (entry) => {
      await acquire()
      try {
        return await run(entry)
      } catch (error) {
        if (isAuthError(error)) {
          clearToken(entry.workspace.id)
          if (shouldThrowAuthError(selection)) {
            throw error
          }
        } else {
          console.warn(`[asana] ${label} failed:`, error)
        }
        return []
      } finally {
        release()
      }
    })
  )
}

import type {
  AsanaComment,
  AsanaProject,
  AsanaSection,
  AsanaTask,
  AsanaTaskFilter,
  AsanaUser,
  AsanaWorkspaceSelection
} from '../../shared/types'
import {
  acquire,
  asanaRequest,
  AsanaApiError,
  clearToken,
  getClients,
  isAuthError,
  isSearchUnavailable,
  markSearchUnavailable,
  release
} from './client'
import {
  asRecord,
  asString,
  clampLimit,
  mapAsanaTask,
  mapComment,
  mapProject,
  mapUser,
  shouldThrowAuthError,
  sortAndLimitTasks,
  TASK_FIELDS,
  type AsanaItemResponse,
  type AsanaListResponse
} from './asana-task-mapping'
import { fanOut, fetchMyTasks, filterTasksLocally } from './asana-task-fetch'

export async function listTasks(
  filter: AsanaTaskFilter = 'assigned',
  limit = 30,
  workspaceId?: AsanaWorkspaceSelection | null,
  projectId?: string | null
): Promise<AsanaTask[]> {
  const entries = getClients(workspaceId)
  if (entries.length === 0) {
    return []
  }
  const safeLimit = clampLimit(limit)
  // Why: the project filter is gated to a single concrete workspace in the UI,
  // so a project query resolves to one client. Slice defensively in case 'all'
  // ever reaches here — both the search and /tasks paths target one workspace.
  const targets = projectId ? entries.slice(0, 1) : entries
  const results = await fanOut(targets, workspaceId, 'listTasks', (entry) =>
    fetchMyTasks(entry, filter, safeLimit, projectId)
  )
  // Why: Asana's /tasks list has no server-side sort param, so order by
  // modified_at desc to match GitHub/Jira's "recently updated first" default —
  // single- and multi-workspace results stay consistent.
  return sortAndLimitTasks(results.flat(), safeLimit)
}

export async function searchTasks(
  query: string,
  limit = 30,
  workspaceId?: AsanaWorkspaceSelection | null
): Promise<AsanaTask[]> {
  const entries = getClients(workspaceId)
  const text = query.trim()
  if (entries.length === 0 || !text) {
    return []
  }
  const safeLimit = clampLimit(limit)
  const results = await fanOut(entries, workspaceId, 'searchTasks', async (entry) => {
    // Why: Asana has no plan-tier API, so a prior 402 is the only signal that
    // this workspace lacks premium search. Skip the doomed call once we know.
    if (isSearchUnavailable(entry.workspace.id)) {
      return filterTasksLocally(entry, text)
    }
    try {
      // Why: the search endpoint's sort_by defaults to modified_at desc, but set
      // it explicitly so search order matches listTasks' "recently updated first".
      const params = new URLSearchParams({
        text,
        opt_fields: TASK_FIELDS,
        limit: String(safeLimit),
        sort_by: 'modified_at',
        sort_ascending: 'false'
      })
      const response = await asanaRequest<AsanaListResponse>(
        entry,
        `/workspaces/${encodeURIComponent(entry.workspace.id)}/tasks/search?${params.toString()}`
      )
      return (response.data ?? []).map((task) => mapAsanaTask(entry.workspace, task))
    } catch (error) {
      // Why: typeahead/search is a premium-only endpoint that returns 402 on free
      // tiers. Only that status means "search unavailable" — remember it so future
      // searches skip straight to the local filter, then fall back now. Every other
      // status (429/5xx/400) is a real failure that must propagate, not be masked.
      if (error instanceof AsanaApiError && error.status === 402) {
        console.warn('[asana] search endpoint unavailable (402), using local title filter')
        markSearchUnavailable(entry.workspace.id)
        return filterTasksLocally(entry, text)
      }
      throw error
    }
  })
  // Why: server already returns modified_at desc, but the 402 local-filter
  // fallback and multi-workspace merge are unsorted — normalize to keep order
  // consistent regardless of which path produced the results.
  return sortAndLimitTasks(results.flat(), safeLimit)
}

export async function getTask(
  gid: string,
  workspaceId?: AsanaWorkspaceSelection | null
): Promise<AsanaTask | null> {
  const entries = getClients(workspaceId)
  for (const entry of entries) {
    await acquire()
    try {
      const response = await asanaRequest<AsanaItemResponse>(
        entry,
        `/tasks/${encodeURIComponent(gid)}?opt_fields=${encodeURIComponent(TASK_FIELDS)}`
      )
      if (response.data) {
        return mapAsanaTask(entry.workspace, response.data)
      }
    } catch (error) {
      if (isAuthError(error)) {
        clearToken(entry.workspace.id)
        if (shouldThrowAuthError(workspaceId)) {
          throw error
        }
      } else if (!(error instanceof AsanaApiError && error.status === 404)) {
        console.warn('[asana] getTask failed:', error)
      }
    } finally {
      release()
    }
  }
  return null
}

export async function getTaskComments(
  gid: string,
  workspaceId?: string | null
): Promise<AsanaComment[]> {
  const entry = getClients(workspaceId)[0]
  if (!entry) {
    return []
  }
  await acquire()
  try {
    const params = new URLSearchParams({
      opt_fields: 'text,created_at,created_by.name,created_by.email,type',
      limit: '100'
    })
    const response = await asanaRequest<AsanaListResponse>(
      entry,
      `/tasks/${encodeURIComponent(gid)}/stories?${params.toString()}`
    )
    // Why: the stories feed includes system events (assignments, status
    // changes); only `comment` stories carry user-authored text.
    return (response.data ?? [])
      .filter((story) => asRecord(story).type === 'comment')
      .map(mapComment)
  } catch (error) {
    if (isAuthError(error)) {
      clearToken(entry.workspace.id)
      throw error
    }
    console.warn('[asana] getTaskComments failed:', error)
    return []
  } finally {
    release()
  }
}

export async function listProjects(
  workspaceId?: AsanaWorkspaceSelection | null
): Promise<AsanaProject[]> {
  const entries = getClients(workspaceId)
  if (entries.length === 0) {
    return []
  }
  const results = await fanOut(entries, workspaceId, 'listProjects', async (entry) => {
    const params = new URLSearchParams({
      workspace: entry.workspace.id,
      opt_fields: 'name',
      limit: '100',
      archived: 'false'
    })
    const response = await asanaRequest<AsanaListResponse>(entry, `/projects?${params.toString()}`)
    return (response.data ?? []).map((project) => mapProject(project, entry.workspace))
  })
  return results.flat().sort((a, b) => a.name.localeCompare(b.name))
}

export async function listSections(
  projectGid: string,
  workspaceId?: string | null
): Promise<AsanaSection[]> {
  const entry = getClients(workspaceId)[0]
  if (!entry) {
    return []
  }
  await acquire()
  try {
    const params = new URLSearchParams({ opt_fields: 'name', limit: '100' })
    const response = await asanaRequest<AsanaListResponse>(
      entry,
      `/projects/${encodeURIComponent(projectGid)}/sections?${params.toString()}`
    )
    return (response.data ?? []).map((section) => ({
      gid: asString(asRecord(section).gid),
      name: asString(asRecord(section).name, 'Section')
    }))
  } catch (error) {
    if (isAuthError(error)) {
      clearToken(entry.workspace.id)
      throw error
    }
    console.warn('[asana] listSections failed:', error)
    return []
  } finally {
    release()
  }
}

export async function listAssignableUsers(
  workspaceId?: string | null,
  query?: string
): Promise<AsanaUser[]> {
  const entry = getClients(workspaceId)[0]
  if (!entry) {
    return []
  }
  await acquire()
  try {
    const params = new URLSearchParams({
      workspace: entry.workspace.id,
      opt_fields: 'name,email,photo.image_60x60,photo.image_36x36',
      limit: '100'
    })
    const response = await asanaRequest<AsanaListResponse>(entry, `/users?${params.toString()}`)
    const users = (response.data ?? [])
      .map((user) => mapUser(user))
      .filter((user): user is AsanaUser => !!user)
    const trimmed = query?.trim().toLowerCase()
    return trimmed
      ? users.filter(
          (user) =>
            user.name.toLowerCase().includes(trimmed) ||
            (user.email ?? '').toLowerCase().includes(trimmed)
        )
      : users
  } catch (error) {
    if (isAuthError(error)) {
      clearToken(entry.workspace.id)
      throw error
    }
    console.warn('[asana] listAssignableUsers failed:', error)
    return []
  } finally {
    release()
  }
}

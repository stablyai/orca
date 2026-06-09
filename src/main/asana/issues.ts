/* eslint-disable max-lines -- Why: Asana task reads and mutations share field
   mapping, multi-workspace fan-out, and auth-clearing behavior; keeping the API
   boundary together avoids subtle drift between operations. */
import type {
  AsanaApprovalStatus,
  AsanaComment,
  AsanaCreateTaskArgs,
  AsanaCreateTaskResult,
  AsanaMutationResult,
  AsanaProject,
  AsanaSection,
  AsanaTask,
  AsanaTaskFilter,
  AsanaTaskUpdate,
  AsanaUser,
  AsanaWorkspace,
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
  release,
  type AsanaClientForWorkspace
} from './client'

type AsanaRecord = Record<string, unknown>

const TASK_FIELDS = [
  'name',
  'notes',
  'permalink_url',
  'completed',
  'resource_subtype',
  'approval_status',
  'due_on',
  'assignee.name',
  'assignee.email',
  'assignee.photo.image_60x60',
  'assignee.photo.image_36x36',
  'projects.name',
  'created_at',
  'modified_at',
  'memberships.section.name'
].join(',')

type AsanaListResponse = {
  data?: AsanaRecord[]
  next_page?: { offset?: string } | null
}

type AsanaItemResponse = {
  data?: AsanaRecord
}

function clampLimit(limit: number | undefined, fallback = 30): number {
  return Math.min(Math.max(1, Number.isFinite(limit) ? Number(limit) : fallback), 100)
}

function shouldThrowAuthError(selection: AsanaWorkspaceSelection | null | undefined): boolean {
  return selection !== 'all'
}

function asRecord(value: unknown): AsanaRecord {
  return value && typeof value === 'object' ? (value as AsanaRecord) : {}
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function asArray(value: unknown): AsanaRecord[] {
  return Array.isArray(value) ? value.map(asRecord) : []
}

function mapUser(value: unknown): AsanaUser | undefined {
  const user = asRecord(value)
  const gid = asString(user.gid)
  if (!gid) {
    return undefined
  }
  // Why: Asana's `photo` is null for users without a profile picture, and a
  // record of size variants otherwise — prefer 60px for a crisp small avatar.
  const photo = asRecord(user.photo)
  const photoUrl = asString(photo.image_60x60) || asString(photo.image_36x36) || undefined
  return {
    gid,
    name: asString(user.name, 'Unknown'),
    email: typeof user.email === 'string' ? user.email : undefined,
    photoUrl
  }
}

function mapProject(value: unknown, workspace?: AsanaWorkspace): AsanaProject {
  const project = asRecord(value)
  return {
    gid: asString(project.gid),
    name: asString(project.name, 'Project'),
    workspaceId: workspace?.id,
    workspaceName: workspace?.name
  }
}

function mapSection(value: unknown): string | undefined {
  // Why: a task can belong to several projects; the first membership's section
  // is the most relevant "where does this sit" hint for the list view.
  const memberships = asArray(value)
  for (const membership of memberships) {
    const section = asRecord(membership.section)
    const name = asString(section.name)
    if (name) {
      return name
    }
  }
  return undefined
}

const APPROVAL_STATUSES = new Set<AsanaApprovalStatus>([
  'pending',
  'approved',
  'rejected',
  'changes_requested'
])

function mapApprovalStatus(value: unknown): AsanaApprovalStatus | null {
  return typeof value === 'string' && APPROVAL_STATUSES.has(value as AsanaApprovalStatus)
    ? (value as AsanaApprovalStatus)
    : null
}

export function mapAsanaTask(workspace: AsanaWorkspace, raw: AsanaRecord): AsanaTask {
  const gid = asString(raw.gid)
  return {
    gid,
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    title: asString(raw.name, 'Untitled task'),
    description: asString(raw.notes) || undefined,
    url: asString(raw.permalink_url),
    completed: raw.completed === true,
    resourceSubtype: asString(raw.resource_subtype) || undefined,
    approvalStatus: mapApprovalStatus(raw.approval_status),
    dueOn: asString(raw.due_on) || null,
    assignee: mapUser(raw.assignee),
    projects: asArray(raw.projects).map((project) => mapProject(project, workspace)),
    section: mapSection(raw.memberships),
    createdAt: asString(raw.created_at, new Date().toISOString()),
    updatedAt: asString(raw.modified_at, new Date().toISOString())
  }
}

function sortAndLimitTasks(tasks: AsanaTask[], limit: number): AsanaTask[] {
  // Why: parse each updatedAt once into a sort key rather than re-parsing both
  // operands on every comparator call (O(n log n) Date allocations otherwise).
  return tasks
    .map((task) => ({ task, ts: new Date(task.updatedAt).getTime() }))
    .sort((a, b) => b.ts - a.ts)
    .slice(0, limit)
    .map((entry) => entry.task)
}

async function fetchTasksForClient(
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
async function fetchMyTasks(
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
async function filterTasksLocally(
  entry: AsanaClientForWorkspace,
  text: string
): Promise<AsanaTask[]> {
  const tasks = await fetchTasksForClient(entry, 'all', 100)
  const lowered = text.toLowerCase()
  return tasks.filter((task) => task.title.toLowerCase().includes(lowered))
}

async function fanOut<T>(
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

export async function createTask(args: AsanaCreateTaskArgs): Promise<AsanaCreateTaskResult> {
  const entry = getClients(args.workspaceId)[0]
  if (!entry) {
    return { ok: false, error: 'Not connected to Asana.' }
  }
  const title = args.title.trim()
  if (!title) {
    return { ok: false, error: 'Title is required.' }
  }

  await acquire()
  try {
    const data: AsanaRecord = { name: title }
    if (args.projectId?.trim()) {
      data.projects = [args.projectId.trim()]
    } else {
      data.workspace = entry.workspace.id
    }
    if (args.notes?.trim()) {
      data.notes = args.notes.trim()
    }
    if (args.assigneeGid?.trim()) {
      data.assignee = args.assigneeGid.trim()
    }
    const response = await asanaRequest<AsanaItemResponse>(
      entry,
      '/tasks?opt_fields=permalink_url',
      {
        method: 'POST',
        body: JSON.stringify({ data })
      }
    )
    const created = asRecord(response.data)
    const gid = asString(created.gid)
    return { ok: true, gid, url: asString(created.permalink_url) }
  } catch (error) {
    if (isAuthError(error)) {
      clearToken(entry.workspace.id)
      throw error
    }
    return { ok: false, error: error instanceof Error ? error.message : 'Failed to create task.' }
  } finally {
    release()
  }
}

export async function updateTask(
  gid: string,
  updates: AsanaTaskUpdate,
  workspaceId?: string | null
): Promise<AsanaMutationResult> {
  const entry = getClients(workspaceId)[0]
  if (!entry) {
    return { ok: false, error: 'Not connected to Asana.' }
  }
  await acquire()
  try {
    const data: AsanaRecord = {}
    if (updates.title !== undefined) {
      data.name = updates.title
    }
    if (updates.notes !== undefined) {
      data.notes = updates.notes
    }
    if (updates.completed !== undefined) {
      data.completed = updates.completed
    }
    // Why: approval tasks resolve via approval_status, not completed — Asana
    // keeps the two in sync (approved/rejected/changes_requested ⇒ completed).
    if (updates.approvalStatus !== undefined) {
      data.approval_status = updates.approvalStatus
    }
    if (updates.assigneeGid !== undefined) {
      data.assignee = updates.assigneeGid
    }
    if (updates.dueOn !== undefined) {
      data.due_on = updates.dueOn
    }
    if (Object.keys(data).length > 0) {
      await asanaRequest(entry, `/tasks/${encodeURIComponent(gid)}`, {
        method: 'PUT',
        body: JSON.stringify({ data })
      })
    }
    return { ok: true }
  } catch (error) {
    if (isAuthError(error)) {
      clearToken(entry.workspace.id)
      throw error
    }
    return { ok: false, error: error instanceof Error ? error.message : 'Failed to update task.' }
  } finally {
    release()
  }
}

export async function addTaskComment(
  gid: string,
  text: string,
  workspaceId?: string | null
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const entry = getClients(workspaceId)[0]
  if (!entry) {
    return { ok: false, error: 'Not connected to Asana.' }
  }
  await acquire()
  try {
    const response = await asanaRequest<AsanaItemResponse>(
      entry,
      `/tasks/${encodeURIComponent(gid)}/stories`,
      {
        method: 'POST',
        body: JSON.stringify({ data: { text } })
      }
    )
    return { ok: true, id: asString(asRecord(response.data).gid) }
  } catch (error) {
    if (isAuthError(error)) {
      clearToken(entry.workspace.id)
      throw error
    }
    return { ok: false, error: error instanceof Error ? error.message : 'Failed to add comment.' }
  } finally {
    release()
  }
}

function mapComment(raw: AsanaRecord): AsanaComment {
  return {
    gid: asString(raw.gid),
    text: asString(raw.text),
    createdAt: asString(raw.created_at, new Date().toISOString()),
    user: mapUser(raw.created_by)
  }
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

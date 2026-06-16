import type {
  AsanaCreateTaskArgs,
  AsanaCreateTaskResult,
  AsanaMutationResult,
  AsanaTaskUpdate
} from '../../shared/types'
import { acquire, asanaRequest, clearToken, getClients, isAuthError, release } from './client'
import { asRecord, asString, type AsanaItemResponse, type AsanaRecord } from './asana-task-mapping'

// Read operations live in a focused module; re-exported here so existing
// importers (runtime, IPC) keep using a single Asana task API surface.
export {
  getTask,
  getTaskComments,
  listAssignableUsers,
  listProjects,
  listSections,
  listTasks,
  searchTasks
} from './asana-task-queries'

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

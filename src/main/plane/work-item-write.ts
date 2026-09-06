import type {
  PlaneCreateWorkItemArgs,
  PlaneCreateWorkItemResult,
  PlaneMutationResult,
  PlaneProject,
  PlaneWorkItem,
  PlaneWorkItemUpdate
} from '../../shared/plane-types'
import { buildPlaneWorkItemUrl } from '../../shared/plane-work-item-url'
import {
  isPlaneAuthError,
  planeRequest,
  workspacePath,
  type PlaneClientForWorkspace
} from './authenticated-request'
import { textToPlaneHtml } from './description-markdown'
import { getWorkItem } from './work-items'

function workItemsPath(client: PlaneClientForWorkspace, projectId: string, suffix = ''): string {
  return workspacePath(
    client.workspace,
    `projects/${encodeURIComponent(projectId)}/work-items/${suffix}`
  )
}

/** Plane replaces the whole set on write, so null clears rather than omits. */
function buildUpdatePayload(update: PlaneWorkItemUpdate): Record<string, unknown> {
  const payload: Record<string, unknown> = {}
  if (update.title !== undefined) {
    payload.name = update.title
  }
  if (update.stateId !== undefined) {
    payload.state = update.stateId
  }
  if (update.priority !== undefined) {
    payload.priority = update.priority
  }
  if (update.assigneeIds !== undefined) {
    payload.assignees = update.assigneeIds ?? []
  }
  if (update.labelIds !== undefined) {
    payload.labels = update.labelIds ?? []
  }
  if (update.targetDate !== undefined) {
    payload.target_date = update.targetDate
  }
  return payload
}

/**
 * Writes report failures as a result rather than throwing, but a revoked token
 * must still reach withClient in provider-operations — otherwise a 401 on a
 * write leaves the stored credential in place until an unrelated read fails.
 */
function rethrowAuthFailure(error: unknown): void {
  if (isPlaneAuthError(error)) {
    throw error
  }
}

export async function updateWorkItem(
  client: PlaneClientForWorkspace,
  project: PlaneProject,
  workItemId: string,
  update: PlaneWorkItemUpdate
): Promise<PlaneMutationResult> {
  const payload = buildUpdatePayload(update)
  if (Object.keys(payload).length === 0) {
    return { ok: true }
  }
  try {
    await planeRequest(
      client,
      workItemsPath(client, project.id, `${encodeURIComponent(workItemId)}/`),
      {
        method: 'PATCH',
        body: JSON.stringify(payload)
      }
    )
    return { ok: true }
  } catch (error) {
    rethrowAuthFailure(error)
    return { ok: false, error: error instanceof Error ? error.message : 'Update failed.' }
  }
}

export async function createWorkItem(
  client: PlaneClientForWorkspace,
  project: PlaneProject,
  args: PlaneCreateWorkItemArgs
): Promise<PlaneCreateWorkItemResult> {
  const title = args.title.trim()
  if (!title) {
    return { ok: false, error: 'A work item needs a title.' }
  }
  const payload: Record<string, unknown> = { name: title }
  if (args.description) {
    payload.description_html = textToPlaneHtml(args.description)
  }
  if (args.stateId) {
    payload.state = args.stateId
  }
  if (args.priority) {
    payload.priority = args.priority
  }
  if (args.assigneeIds?.length) {
    payload.assignees = args.assigneeIds
  }
  if (args.labelIds?.length) {
    payload.labels = args.labelIds
  }

  try {
    const created = (await planeRequest<unknown>(client, workItemsPath(client, project.id), {
      method: 'POST',
      body: JSON.stringify(payload)
    })) as Record<string, unknown> | null
    const id = typeof created?.id === 'string' ? created.id : null
    const sequenceId = Number(created?.sequence_id)
    // Why: matches parsePlaneWorkItemKey, so the key handed back never fails
    // the parser on its way back in.
    if (!id || !Number.isSafeInteger(sequenceId) || sequenceId <= 0) {
      return { ok: false, error: 'Plane accepted the work item but returned no identifier.' }
    }
    const key = `${project.identifier}-${sequenceId}`
    return { ok: true, id, key, url: buildPlaneWorkItemUrl(client.workspace, key) }
  } catch (error) {
    rethrowAuthFailure(error)
    return { ok: false, error: error instanceof Error ? error.message : 'Create failed.' }
  }
}

export async function addComment(
  client: PlaneClientForWorkspace,
  project: PlaneProject,
  workItemId: string,
  body: string
): Promise<PlaneMutationResult> {
  const html = textToPlaneHtml(body)
  if (!html) {
    return { ok: false, error: 'A comment needs some text.' }
  }
  try {
    await planeRequest(
      client,
      workItemsPath(client, project.id, `${encodeURIComponent(workItemId)}/comments/`),
      { method: 'POST', body: JSON.stringify({ comment_html: html }) }
    )
    return { ok: true }
  } catch (error) {
    rethrowAuthFailure(error)
    return { ok: false, error: error instanceof Error ? error.message : 'Comment failed.' }
  }
}

/** Moves a work item and returns the refreshed row so callers can re-render. */
export async function moveWorkItemToState(
  client: PlaneClientForWorkspace,
  project: PlaneProject,
  workItem: PlaneWorkItem,
  stateId: string
): Promise<{ ok: true; workItem: PlaneWorkItem | null } | { ok: false; error: string }> {
  if (workItem.state.id === stateId) {
    return { ok: true, workItem }
  }
  const result = await updateWorkItem(client, project, workItem.id, { stateId })
  if (!result.ok) {
    return result
  }
  return { ok: true, workItem: await getWorkItem(client, project, workItem.id) }
}

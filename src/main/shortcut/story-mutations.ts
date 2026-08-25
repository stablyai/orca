import type {
  ShortcutCreateStoryArgs,
  ShortcutCreateStoryResult,
  ShortcutMutationResult,
  ShortcutStoryUpdate
} from '../../shared/shortcut-types'
import { acquire, release } from './request-queue'
import { shortcutRequest } from './authenticated-request'
import { clearToken, getClients, isAuthError } from './client'
import { asIdentifier, asRecord, asString, type ShortcutRecord } from './api-mapping'

export async function createStory(
  args: ShortcutCreateStoryArgs
): Promise<ShortcutCreateStoryResult> {
  const entry = getClients(args.workspaceId)[0]
  if (!entry) {
    return { ok: false, error: 'Not connected to Shortcut.' }
  }
  const title = args.title.trim()
  if (!title) {
    return { ok: false, error: 'Title is required.' }
  }
  await acquire()
  try {
    const body: ShortcutRecord = { name: title }
    if (args.description?.trim()) {
      body.description = args.description.trim()
    }
    if (args.storyType) {
      body.story_type = args.storyType
    }
    if (args.teamId) {
      body.group_id = args.teamId
    }
    if (args.workflowStateId) {
      const workflowStateId = Number(args.workflowStateId)
      // Why: NaN serializes to null in JSON, silently sending workflow_state_id: null.
      if (!Number.isInteger(workflowStateId)) {
        return { ok: false, error: 'Invalid workflow state.' }
      }
      body.workflow_state_id = workflowStateId
    }
    const created = await shortcutRequest<ShortcutRecord>(entry, '/api/v3/stories', {
      method: 'POST',
      body: JSON.stringify(body)
    })
    const id = asIdentifier(created.id)
    const url =
      asString(created.app_url) ||
      `https://app.shortcut.com/${encodeURIComponent(entry.workspace.urlSlug)}/story/${encodeURIComponent(id)}`
    return { ok: true, id, url }
  } catch (error) {
    if (isAuthError(error)) {
      clearToken(entry.workspace.id)
      throw error
    }
    return { ok: false, error: error instanceof Error ? error.message : 'Failed to create story.' }
  } finally {
    release()
  }
}

export async function updateStory(
  storyId: string,
  updates: ShortcutStoryUpdate,
  workspaceId?: string | null
): Promise<ShortcutMutationResult> {
  const entry = getClients(workspaceId)[0]
  if (!entry) {
    return { ok: false, error: 'Not connected to Shortcut.' }
  }
  await acquire()
  try {
    const body: ShortcutRecord = {}
    if (updates.title !== undefined) {
      body.name = updates.title
    }
    if (updates.labels !== undefined) {
      body.labels = updates.labels.map((name) => ({ name }))
    }
    if (updates.ownerIds !== undefined) {
      body.owner_ids = updates.ownerIds
    }
    if (updates.workflowStateId !== undefined) {
      const workflowStateId = Number(updates.workflowStateId)
      if (!Number.isInteger(workflowStateId)) {
        return { ok: false, error: 'Invalid workflow state.' }
      }
      body.workflow_state_id = workflowStateId
    }
    if (updates.storyType !== undefined) {
      body.story_type = updates.storyType
    }
    if (Object.keys(body).length > 0) {
      await shortcutRequest(entry, `/api/v3/stories/${encodeURIComponent(storyId)}`, {
        method: 'PUT',
        body: JSON.stringify(body)
      })
    }
    return { ok: true }
  } catch (error) {
    if (isAuthError(error)) {
      clearToken(entry.workspace.id)
      throw error
    }
    return { ok: false, error: error instanceof Error ? error.message : 'Failed to update story.' }
  } finally {
    release()
  }
}

export async function addStoryComment(
  storyId: string,
  body: string,
  workspaceId?: string | null
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const entry = getClients(workspaceId)[0]
  if (!entry) {
    return { ok: false, error: 'Not connected to Shortcut.' }
  }
  await acquire()
  try {
    const comment = await shortcutRequest<ShortcutRecord>(
      entry,
      `/api/v3/stories/${encodeURIComponent(storyId)}/comments`,
      {
        method: 'POST',
        body: JSON.stringify({ text: body })
      }
    )
    return { ok: true, id: asIdentifier(asRecord(comment).id) }
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

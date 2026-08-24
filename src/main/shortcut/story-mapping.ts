import type {
  ShortcutComment,
  ShortcutMember,
  ShortcutStory,
  ShortcutWorkspace
} from '../../shared/shortcut-types'
import {
  asFiniteNumber,
  asIdentifier,
  asRecord,
  asString,
  mapStoryType,
  type ShortcutRecord
} from './api-mapping'
import type { ShortcutWorkspaceMetadata } from './workspace-metadata'

function storyUrl(workspace: ShortcutWorkspace, raw: ShortcutRecord, id: string): string {
  return (
    asString(raw.app_url) ||
    `https://app.shortcut.com/${encodeURIComponent(workspace.urlSlug)}/story/${encodeURIComponent(id)}`
  )
}

function mapLabels(raw: ShortcutRecord): string[] {
  if (!Array.isArray(raw.labels)) {
    return []
  }
  return raw.labels
    .map((label) => asString(asRecord(label).name))
    .filter((name): name is string => name.length > 0)
}

function resolveMember(
  metadata: ShortcutWorkspaceMetadata,
  memberId: string
): ShortcutMember | undefined {
  if (!memberId) {
    return undefined
  }
  return metadata.membersById.get(memberId) ?? { id: memberId, name: 'Unknown' }
}

export function mapStory(
  workspace: ShortcutWorkspace,
  metadata: ShortcutWorkspaceMetadata,
  raw: ShortcutRecord
): ShortcutStory {
  const id = asIdentifier(raw.id)
  const stateId = asIdentifier(raw.workflow_state_id)
  const stateLookup = metadata.statesById.get(stateId)
  const teamId = asIdentifier(raw.group_id)
  const team = teamId ? metadata.teamsById.get(teamId) : undefined
  const ownerIds = Array.isArray(raw.owner_ids)
    ? raw.owner_ids.map(asIdentifier).filter(Boolean)
    : []
  const requesterId = asIdentifier(raw.requested_by_id)
  const estimate = asFiniteNumber(raw.estimate)
  const description = asString(raw.description)
  const now = new Date().toISOString()
  return {
    id,
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    title: asString(raw.name, id ? `Story ${id}` : 'Untitled story'),
    ...(description ? { description } : {}),
    url: storyUrl(workspace, raw, id),
    storyType: mapStoryType(raw.story_type),
    state: stateLookup
      ? { id: stateId, name: stateLookup.state.name, type: stateLookup.state.type }
      : { id: stateId, name: 'Unknown', type: raw.completed === true ? 'done' : 'started' },
    workflowId: stateLookup?.workflowId ?? (asIdentifier(raw.workflow_id) || undefined),
    ...(team
      ? { team: { ...team, workspaceId: workspace.id, workspaceName: workspace.name } }
      : {}),
    epicId: asIdentifier(raw.epic_id) || undefined,
    labels: mapLabels(raw),
    owners: ownerIds
      .map((ownerId) => resolveMember(metadata, ownerId))
      .filter((member): member is ShortcutMember => member !== undefined),
    requester: resolveMember(metadata, requesterId),
    ...(estimate !== null ? { estimate } : {}),
    archived: raw.archived === true,
    completed: raw.completed === true,
    started: raw.started === true,
    blocked: raw.blocked === true || undefined,
    updatedAt: asString(raw.updated_at) || asString(raw.created_at, now),
    createdAt: asString(raw.created_at, now)
  }
}

export function mapComment(
  metadata: ShortcutWorkspaceMetadata,
  raw: unknown
): ShortcutComment | null {
  const comment = asRecord(raw)
  const id = asIdentifier(comment.id)
  // Deleted comments come back with null text; there is nothing to render.
  if (!id || comment.deleted === true || typeof comment.text !== 'string') {
    return null
  }
  return {
    id,
    body: comment.text,
    createdAt: asString(comment.created_at, new Date().toISOString()),
    updatedAt: asString(comment.updated_at) || undefined,
    author: resolveMember(metadata, asIdentifier(comment.author_id))
  }
}

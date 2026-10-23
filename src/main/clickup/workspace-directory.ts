import type { ClickUpTag, ClickUpUser } from '../../shared/clickup-types'
import { clickUpRequest, requireClickUpClient } from './client'
import { asRecord, asString, normalizeClickUpTag, normalizeClickUpUser } from './task-mapping'

export { clearClickUpListCache, listClickUpLists, listClickUpSpaces } from './list-hierarchy'

export async function listClickUpWorkspaceMembers(workspaceId?: string): Promise<ClickUpUser[]> {
  const client = requireClickUpClient(workspaceId)
  const response = await clickUpRequest<{ teams?: unknown[] }>(client, '/team')
  const workspace = (response.teams ?? [])
    .map(asRecord)
    .find((team) => asString(team?.id) === client.workspace.id)
  return (Array.isArray(workspace?.members) ? workspace.members : [])
    .map((member) => normalizeClickUpUser(asRecord(member)?.user ?? member))
    .filter((user): user is ClickUpUser => user !== null)
}

export async function listClickUpWorkspaceTags(workspaceId?: string): Promise<ClickUpTag[]> {
  const client = requireClickUpClient(workspaceId)
  const response = await clickUpRequest<{ tags?: unknown[] }>(
    client,
    `/team/${encodeURIComponent(client.workspace.id)}/tag`
  )
  return (response.tags ?? [])
    .map(normalizeClickUpTag)
    .filter((tag): tag is ClickUpTag => tag !== null)
}

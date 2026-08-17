import type { LinearProjectCreateRequest } from '../../shared/linear/project-agent-writes'
import { linearError } from '../linear/issue-context-errors'
import { normalizeLinearLineEndings } from '../linear/linear-text-digest'
import { resolveProjectCreateScope } from '../linear/project-create-workspace-scope'
import { resolveWorkspaceUserForWrite } from '../linear/project-write-actors'
import {
  resolveProjectLabelsForWrite,
  resolveProjectStatusForWrite
} from '../linear/project-write-references'
import type { LinearProjectCreateIntent } from './linear-project-create-intent'

type ReadOptions = { signal?: AbortSignal }

/**
 * Turns one create request's user-input strings into a resolved intent. The team
 * set fixes the workspace first, so every other reference resolves inside it.
 */
export async function resolveLinearProjectCreateIntent(
  request: LinearProjectCreateRequest,
  options: ReadOptions = {}
): Promise<LinearProjectCreateIntent> {
  const name = request.name.trim()
  if (!name) {
    throw linearError('linear_invalid_project', 'A Linear project name is required.')
  }
  const scope = await resolveProjectCreateScope(
    dedupeTeamInputs(request.teams),
    request.workspaceId,
    options
  )
  const workspaceId = scope.workspaceId
  const statusId = request.status
    ? (await resolveProjectStatusForWrite(request.status, workspaceId, options)).id
    : undefined
  const leadId = request.lead
    ? (await resolveWorkspaceUserForWrite(request.lead, workspaceId, options)).id
    : undefined
  const memberIds = request.members?.length
    ? await resolveMemberIds(request.members, workspaceId, options)
    : undefined
  const labelIds = request.labels?.length
    ? (await resolveProjectLabelsForWrite(request.labels, workspaceId, options)).map(
        (label) => label.id
      )
    : undefined
  return {
    workspaceId,
    name,
    teamIds: scope.teams.map((team) => team.id),
    ...(request.description !== undefined
      ? { description: normalizeLinearLineEndings(request.description) }
      : {}),
    ...(request.content !== undefined
      ? { content: normalizeLinearLineEndings(request.content) }
      : {}),
    ...(statusId ? { statusId } : {}),
    ...(leadId ? { leadId } : {}),
    ...(memberIds ? { memberIds } : {}),
    ...(labelIds ? { labelIds } : {}),
    // Why: priority 0 (`none`) is a real request and must survive a falsy check.
    ...(request.priority !== undefined ? { priority: request.priority } : {}),
    ...(request.startDate ? { startDate: request.startDate } : {}),
    ...(request.targetDate ? { targetDate: request.targetDate } : {}),
    ...(request.color ? { color: request.color } : {}),
    ...(request.icon ? { icon: request.icon } : {})
  }
}

async function resolveMemberIds(
  inputs: string[],
  workspaceId: string,
  options: ReadOptions
): Promise<string[]> {
  const ids: string[] = []
  for (const input of inputs) {
    const user = await resolveWorkspaceUserForWrite(input, workspaceId, options)
    if (!ids.includes(user.id)) {
      ids.push(user.id)
    }
  }
  return ids
}

// Why: the same team typed twice would otherwise cost one lookup per connected workspace.
function dedupeTeamInputs(teams: string[]): string[] {
  const seen = new Set<string>()
  const unique: string[] = []
  for (const team of teams) {
    const trimmed = team.trim()
    const key = trimmed.toLowerCase()
    if (!trimmed || seen.has(key)) {
      continue
    }
    seen.add(key)
    unique.push(trimmed)
  }
  return unique
}

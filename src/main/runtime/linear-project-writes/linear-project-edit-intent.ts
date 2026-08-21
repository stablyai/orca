import {
  LINEAR_PROJECT_EDITABLE_FIELDS,
  type LinearProjectEditRequest,
  type LinearProjectEditableField
} from '../../../shared/linear/project-agent-writes'
import { linearError } from '../../linear/issue-context-errors'
import { normalizeLinearLineEndings } from '../../linear/linear-text-digest'
import type { LinearProjectFieldEdits } from '../../linear/project-field-edits'
import { dedupeLinearReferenceInputs } from '../../linear/project-reference-inputs'
import {
  resolveWorkspaceTeamsForWrite,
  resolveWorkspaceUserForWrite
} from '../../linear/project-write-actors'
import {
  resolveProjectLabelsForWrite,
  resolveProjectStatusForWrite
} from '../../linear/project-write-references'
import { assertLinearProjectTextCaps } from './linear-project-text-caps'

type ReadOptions = { signal?: AbortSignal }

/** One edit request with every reference resolved, plus the fields it asked for. */
export type LinearProjectEditIntent = {
  requested: LinearProjectEditableField[]
  edits: LinearProjectFieldEdits
}

/** A field counts as requested when the caller sent it, including an explicit clear. */
export function requestedLinearProjectEditFields(
  request: LinearProjectEditRequest
): LinearProjectEditableField[] {
  return LINEAR_PROJECT_EDITABLE_FIELDS.filter((field) => request[field] !== undefined)
}

/** Turns one edit request's user-input strings into resolved ids inside one workspace. */
export async function resolveLinearProjectEditIntent(
  request: LinearProjectEditRequest,
  workspaceId: string,
  options: ReadOptions = {}
): Promise<LinearProjectEditIntent> {
  const requested = requestedLinearProjectEditFields(request)
  if (requested.length === 0) {
    throw linearError('linear_invalid_project', 'At least one field to edit is required.')
  }
  const name = request.name?.trim()
  if (request.name !== undefined && !name) {
    throw linearError('linear_invalid_project', 'A Linear project name is required.')
  }
  if (request.teams?.length === 0) {
    throw linearError('linear_team_required', 'A project team replacement needs at least one team.')
  }
  assertLinearProjectTextCaps(name, request.description)
  return {
    requested,
    edits: {
      ...(name !== undefined ? { name } : {}),
      ...(request.description !== undefined
        ? { description: normalizeLinearLineEndings(request.description) }
        : {}),
      ...(request.content !== undefined ? { content: normalizeProse(request.content) } : {}),
      ...(await resolveEditReferences(request, workspaceId, options)),
      // Why: priority 0 (`none`) is a real request and must survive a falsy check.
      ...(request.priority !== undefined ? { priority: request.priority } : {}),
      ...(request.startDate !== undefined ? { startDate: request.startDate } : {}),
      ...(request.targetDate !== undefined ? { targetDate: request.targetDate } : {}),
      ...(request.color !== undefined ? { color: request.color } : {})
    }
  }
}

async function resolveEditReferences(
  request: LinearProjectEditRequest,
  workspaceId: string,
  options: ReadOptions
): Promise<LinearProjectFieldEdits> {
  const statusId =
    request.status !== undefined
      ? (await resolveProjectStatusForWrite(request.status, workspaceId, options)).id
      : undefined
  const leadId = await resolveLeadId(request.lead, workspaceId, options)
  const memberIds = request.members
    ? await resolveMemberIds(dedupeLinearReferenceInputs(request.members), workspaceId, options)
    : undefined
  const teamIds = request.teams
    ? await resolveTeamIds(dedupeLinearReferenceInputs(request.teams), workspaceId, options)
    : undefined
  const labelIds = await resolveLabelIds(request.labels, workspaceId, options)
  return {
    ...(statusId !== undefined ? { statusId } : {}),
    ...(request.lead !== undefined ? { leadId } : {}),
    ...(memberIds !== undefined ? { memberIds } : {}),
    ...(teamIds !== undefined ? { teamIds } : {}),
    ...(labelIds !== undefined ? { labelIds } : {})
  }
}

async function resolveLeadId(
  lead: string | null | undefined,
  workspaceId: string,
  options: ReadOptions
): Promise<string | null> {
  if (lead === undefined || lead === null) {
    return null
  }
  return (await resolveWorkspaceUserForWrite(lead, workspaceId, options)).id
}

/** A team replacement may never be empty, so a blank-only team set fails closed. */
async function resolveTeamIds(
  inputs: string[],
  workspaceId: string,
  options: ReadOptions
): Promise<string[]> {
  if (inputs.length === 0) {
    throw linearError('linear_team_required', 'A project team replacement needs at least one team.')
  }
  const teams = await resolveWorkspaceTeamsForWrite(inputs, workspaceId, options)
  return teams.map((team) => team.id)
}

async function resolveLabelIds(
  inputs: string[] | undefined,
  workspaceId: string,
  options: ReadOptions
): Promise<string[] | undefined> {
  if (inputs === undefined) {
    return undefined
  }
  // Why: `--clear-labels` arrives as [], the explicit clear, and needs no lookup.
  if (inputs.length === 0) {
    return []
  }
  const labels = await resolveProjectLabelsForWrite(inputs, workspaceId, options)
  return labels.map((label) => label.id)
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

function normalizeProse(value: string | null): string | null {
  return value === null ? null : normalizeLinearLineEndings(value)
}

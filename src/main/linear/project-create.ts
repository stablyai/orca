import type { LinearClient } from '@linear/sdk'
import { getClients } from './client'
import { normalizeLinearLineEndings } from './linear-text-digest'
import {
  completeProjectWriteRecord,
  linearProjectEntityIds,
  readProjectSnapshotNode,
  sameLinearProjectIdSet,
  sameLinearProjectText,
  type LinearProjectInternalSnapshot,
  type LinearProjectWriteRecord
} from './project-field-snapshot'
import type { ProjectShowNode } from './project-show-query'
import {
  LinearWriteFailure,
  confirmLinearWrite,
  linearWriteClient,
  runLinearLookup,
  runLinearWrite
} from './write-execution'

export type { LinearProjectInternalSnapshot, LinearProjectWriteRecord }

export type LinearProjectCreateFields = {
  /** Always supplied by the host, always UUID v4 — create-style idempotency depends on it. */
  id: string
  name: string
  teamIds: string[]
  description?: string
  content?: string
  statusId?: string
  leadId?: string
  memberIds?: string[]
  labelIds?: string[]
  priority?: number
  startDate?: string
  targetDate?: string
  color?: string
  icon?: string
}

const UNCONFIRMED_MESSAGE = 'Project was created but could not be retrieved'

/** `projectCreate` — pinned UUID v4 id, no default template, then a full read-back. */
export async function createProjectForAgent(
  input: LinearProjectCreateFields,
  workspaceId: string,
  options: { signal?: AbortSignal } = {}
): Promise<LinearProjectWriteRecord> {
  assertCreatable(input)
  const entry = getClients(workspaceId)[0]
  if (!entry) {
    throw new LinearWriteFailure('failed', 'Not connected to Linear')
  }

  const node = await runLinearWrite(entry, options.signal, async (client) => {
    const result = await client.createProject(createInput(input))
    if (!result.success) {
      throw new LinearWriteFailure('failed', 'Linear project create failed')
    }
    return await readCreatedProjectNode(client, result)
  })

  // Why: paging the connections outside the write keeps a second acquire off the held slot.
  return await confirmLinearWrite(UNCONFIRMED_MESSAGE, () =>
    completeProjectWriteRecord(entry, node, options.signal)
  )
}

/** Read-back for pinned-id intent verification and duplicate-id recovery; null only on a true miss. */
export async function getProjectByIdForAgent(
  projectId: string,
  workspaceId: string,
  options: { signal?: AbortSignal } = {}
): Promise<LinearProjectWriteRecord | null> {
  const entry = getClients(workspaceId)[0]
  if (!entry) {
    return null
  }

  const client = linearWriteClient(entry, options.signal)
  const node = await runLinearLookup(entry, () => readProjectSnapshotNode(client, projectId))
  if (!node) {
    return null
  }
  return await completeProjectWriteRecord(entry, node, options.signal)
}

/**
 * A pinned id is a deduplicated success only when every REQUESTED field matches.
 * Unrequested fields are ignored because Linear may apply workspace defaults.
 */
export function matchesLinearProjectCreateIntent(
  input: LinearProjectCreateFields,
  record: LinearProjectWriteRecord
): boolean {
  const fields = record.fields
  return (
    record.project.id === input.id &&
    fields.name === input.name &&
    sameLinearProjectIdSet(input.teamIds, linearProjectEntityIds(fields.teams)) &&
    matchesText(input.description, fields.description) &&
    matchesText(input.content, fields.content) &&
    matchesValue(input.statusId, fields.status.id) &&
    matchesValue(input.leadId, fields.lead?.id ?? null) &&
    matchesIds(input.memberIds, fields.members) &&
    matchesIds(input.labelIds, fields.labels) &&
    matchesValue(input.priority, fields.priority) &&
    matchesValue(input.startDate, fields.startDate) &&
    matchesValue(input.targetDate, fields.targetDate) &&
    matchesValue(input.color, fields.color) &&
    matchesValue(input.icon, fields.icon)
  )
}

function matchesText(requested: string | undefined, current: string | null): boolean {
  return requested === undefined || sameLinearProjectText(requested, current)
}

function matchesValue<T>(requested: T | undefined, current: T | null): boolean {
  return requested === undefined || requested === current
}

function matchesIds(
  requested: string[] | undefined,
  current: LinearProjectInternalSnapshot['members' | 'teams' | 'labels']
): boolean {
  return (
    requested === undefined || sameLinearProjectIdSet(requested, linearProjectEntityIds(current))
  )
}

function assertCreatable(input: LinearProjectCreateFields): void {
  if (!input.name.trim()) {
    throw new LinearWriteFailure('failed', 'Linear project create requires a name')
  }
  if (input.teamIds.length === 0) {
    throw new LinearWriteFailure('failed', 'Linear project create requires at least one team')
  }
  if (!input.id) {
    throw new LinearWriteFailure('failed', 'Linear project create requires a write id')
  }
}

function createInput(
  input: LinearProjectCreateFields
): Parameters<LinearClient['createProject']>[0] {
  return {
    id: input.id,
    name: input.name,
    teamIds: input.teamIds,
    // Why: a hidden team template would make requested-field verification and retry intent nondeterministic.
    useDefaultTemplate: false,
    // Why: `!== undefined` throughout — empty prose and priority `none` (0) are meaningful values.
    ...(input.description !== undefined
      ? { description: normalizeLinearLineEndings(input.description) }
      : {}),
    ...(input.content !== undefined ? { content: normalizeLinearLineEndings(input.content) } : {}),
    ...(input.statusId !== undefined ? { statusId: input.statusId } : {}),
    ...(input.leadId !== undefined ? { leadId: input.leadId } : {}),
    ...(input.memberIds !== undefined ? { memberIds: input.memberIds } : {}),
    ...(input.labelIds !== undefined ? { labelIds: input.labelIds } : {}),
    ...(input.priority !== undefined ? { priority: input.priority } : {}),
    ...(input.startDate !== undefined ? { startDate: input.startDate } : {}),
    ...(input.targetDate !== undefined ? { targetDate: input.targetDate } : {}),
    ...(input.color !== undefined ? { color: input.color } : {}),
    ...(input.icon !== undefined ? { icon: input.icon } : {})
  }
}

async function readCreatedProjectNode(
  client: LinearClient,
  result: Awaited<ReturnType<LinearClient['createProject']>>
): Promise<ProjectShowNode> {
  // Why: ProjectPayload.project is nullable, so the created id comes from the payload, never the request.
  const createdId = await confirmLinearWrite(
    UNCONFIRMED_MESSAGE,
    async () => result.projectId ?? (await result.project)?.id ?? null
  )
  if (!createdId) {
    throw new LinearWriteFailure('unconfirmed', UNCONFIRMED_MESSAGE)
  }
  const node = await confirmLinearWrite(UNCONFIRMED_MESSAGE, () =>
    readProjectSnapshotNode(client, createdId)
  )
  if (!node) {
    throw new LinearWriteFailure('unconfirmed', UNCONFIRMED_MESSAGE)
  }
  return node
}

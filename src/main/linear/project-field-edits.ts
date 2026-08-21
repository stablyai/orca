import type { LinearProjectRef } from '../../shared/linear/project-agent-access'
import {
  LINEAR_PROJECT_EDITABLE_FIELDS,
  type LinearProjectEditableField
} from '../../shared/linear/project-agent-writes'
import { getClients } from './client'
import { normalizeLinearLineEndings } from './linear-text-digest'
import {
  linearProjectContentWriteValue,
  sameLinearProjectContent
} from './project-content-rewrites'
import { getProjectByIdForAgent } from './project-create'
import {
  linearProjectEntityIds,
  sameLinearProjectIdSet,
  sameLinearProjectText,
  type LinearProjectInternalSnapshot,
  type LinearProjectWriteRecord
} from './project-field-snapshot'
import { LinearWriteFailure, confirmLinearWrite, runLinearWrite } from './write-execution'

/** Only the present keys were requested. Absent keys are never read, compared or mutated. */
export type LinearProjectFieldEdits = {
  name?: string
  description?: string
  content?: string | null
  statusId?: string
  leadId?: string | null
  memberIds?: string[]
  teamIds?: string[]
  labelIds?: string[]
  priority?: number
  startDate?: string | null
  targetDate?: string | null
  color?: string
}

export type LinearProjectEditOutcome = {
  /** Post-edit identity: a rename moves the project's name, slugId and url together. */
  project: LinearProjectRef
  previous: LinearProjectInternalSnapshot
  current: LinearProjectInternalSnapshot
  /** Every requested field already held the requested value, so no mutation was issued. */
  noop: boolean
}

const UNCONFIRMED_MESSAGE = 'Project may have been edited but the change could not be confirmed'

/**
 * `projectUpdate(id, input)`. `ProjectUpdateInput` has no `id`, so retries cannot dedup:
 * read the complete snapshot, mutate only what differs, then verify by reading back.
 */
export async function editProjectFieldsForAgent(
  projectId: string,
  edits: LinearProjectFieldEdits,
  workspaceId: string,
  options: { signal?: AbortSignal; previous?: LinearProjectWriteRecord } = {}
): Promise<LinearProjectEditOutcome> {
  const requested = normalizeProjectFieldEdits(edits)
  assertEditable(requested)
  const entry = getClients(workspaceId)[0]
  if (!entry) {
    throw new LinearWriteFailure('failed', 'Not connected to Linear')
  }

  // Why: the caller reads this snapshot outside the write deadline so a slow pre-read
  // never reports an edit that was never sent as unconfirmed. It decides what this write
  // mutates, so a snapshot of another project would silently edit against the wrong base.
  if (options.previous && options.previous.project.id !== projectId) {
    throw new LinearWriteFailure('failed', 'Linear project edit snapshot is for another project')
  }
  const previous = options.previous ?? (await readProjectRecord(projectId, workspaceId, options))
  const pending = differingProjectFieldEdits(requested, previous.fields)
  if (!hasProjectFieldEdits(pending)) {
    return {
      project: previous.project,
      previous: previous.fields,
      current: previous.fields,
      noop: true
    }
  }

  try {
    await runLinearWrite(entry, options.signal, async (client) => {
      const result = await client.updateProject(projectId, projectUpdateInput(pending))
      if (!result.success) {
        throw new LinearWriteFailure('failed', 'Linear project edit failed')
      }
    })
  } catch (error) {
    // Why: a field edit has no caller-supplied id to dedup a retry against, so
    // treat Linear's "already exists"-shaped message as unconfirmed (read-back
    // decides) rather than let the raw duplicate_id classification escape as an
    // unmapped error to the RPC boundary.
    if (error instanceof LinearWriteFailure && error.kind === 'duplicate_id') {
      throw new LinearWriteFailure('unconfirmed', UNCONFIRMED_MESSAGE, error)
    }
    throw error
  }

  // Why: the read-back pages connections, which acquires again — it must not run inside the write slot.
  const current = await confirmLinearWrite(UNCONFIRMED_MESSAGE, () =>
    readProjectRecord(projectId, workspaceId, options)
  )
  if (hasProjectFieldEdits(differingProjectFieldEdits(requested, current.fields))) {
    throw new LinearWriteFailure('unconfirmed', UNCONFIRMED_MESSAGE)
  }
  return {
    project: current.project,
    previous: previous.fields,
    current: current.fields,
    noop: false
  }
}

/** Linear ignores a null or empty `content` write, so a clear travels as whitespace. */
function projectUpdateInput(pending: LinearProjectFieldEdits): LinearProjectFieldEdits {
  if (pending.content === undefined) {
    return pending
  }
  return { ...pending, content: linearProjectContentWriteValue(pending.content) }
}

/** LF-normalizes prose and drops duplicate resolved ids before comparison and mutation. */
function normalizeProjectFieldEdits(edits: LinearProjectFieldEdits): LinearProjectFieldEdits {
  const normalized: LinearProjectFieldEdits = { ...edits }
  if (edits.name !== undefined) {
    normalized.name = normalizeLinearLineEndings(edits.name)
  }
  if (edits.description !== undefined) {
    normalized.description = normalizeLinearLineEndings(edits.description)
  }
  if (edits.content != null) {
    normalized.content = normalizeLinearLineEndings(edits.content)
  }
  if (edits.memberIds) {
    normalized.memberIds = [...new Set(edits.memberIds)]
  }
  if (edits.teamIds) {
    normalized.teamIds = [...new Set(edits.teamIds)]
  }
  if (edits.labelIds) {
    normalized.labelIds = [...new Set(edits.labelIds)]
  }
  return normalized
}

/** The requested fields that do not already hold the requested value; collections compare as id sets. */
function differingProjectFieldEdits(
  edits: LinearProjectFieldEdits,
  fields: LinearProjectInternalSnapshot
): LinearProjectFieldEdits {
  const pending: LinearProjectFieldEdits = {}
  if (edits.name !== undefined && !sameLinearProjectText(edits.name, fields.name)) {
    pending.name = edits.name
  }
  if (
    edits.description !== undefined &&
    !sameLinearProjectText(edits.description, fields.description)
  ) {
    pending.description = edits.description
  }
  // Why: Linear rewrites content Markdown as it stores it, so requested text never
  // reads back byte-identical. Comparing intent keeps a re-sent body a no-op and
  // stops a successful write from failing its own read-back verification.
  if (edits.content !== undefined && !sameLinearProjectContent(edits.content, fields.content)) {
    pending.content = edits.content
  }
  if (edits.statusId !== undefined && edits.statusId !== fields.status.id) {
    pending.statusId = edits.statusId
  }
  if (edits.leadId !== undefined && edits.leadId !== (fields.lead?.id ?? null)) {
    pending.leadId = edits.leadId
  }
  if (
    edits.memberIds &&
    !sameLinearProjectIdSet(edits.memberIds, linearProjectEntityIds(fields.members))
  ) {
    pending.memberIds = edits.memberIds
  }
  if (
    edits.teamIds &&
    !sameLinearProjectIdSet(edits.teamIds, linearProjectEntityIds(fields.teams))
  ) {
    pending.teamIds = edits.teamIds
  }
  if (
    edits.labelIds &&
    !sameLinearProjectIdSet(edits.labelIds, linearProjectEntityIds(fields.labels))
  ) {
    pending.labelIds = edits.labelIds
  }
  if (edits.priority !== undefined && edits.priority !== fields.priority) {
    pending.priority = edits.priority
  }
  if (edits.startDate !== undefined && edits.startDate !== fields.startDate) {
    pending.startDate = edits.startDate
  }
  if (edits.targetDate !== undefined && edits.targetDate !== fields.targetDate) {
    pending.targetDate = edits.targetDate
  }
  if (edits.color !== undefined && !sameLinearProjectColor(edits.color, fields.color)) {
    pending.color = edits.color
  }
  return pending
}

/** Linear's own hex-color casing is not guaranteed to match the request's casing. */
function sameLinearProjectColor(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

function hasProjectFieldEdits(edits: LinearProjectFieldEdits): boolean {
  return Object.values(edits).some((value) => value !== undefined)
}

const EDIT_KEY_BY_FIELD: Record<LinearProjectEditableField, keyof LinearProjectFieldEdits> = {
  name: 'name',
  description: 'description',
  content: 'content',
  status: 'statusId',
  lead: 'leadId',
  members: 'memberIds',
  teams: 'teamIds',
  labels: 'labelIds',
  priority: 'priority',
  startDate: 'startDate',
  targetDate: 'targetDate',
  color: 'color'
}

type SnapshotComparison = (
  previous: LinearProjectInternalSnapshot,
  current: LinearProjectInternalSnapshot
) => boolean

const SAME_SNAPSHOT_FIELD: Record<LinearProjectEditableField, SnapshotComparison> = {
  name: (previous, current) => previous.name === current.name,
  description: (previous, current) => previous.description === current.description,
  content: (previous, current) => sameLinearProjectText(previous.content, current.content),
  status: (previous, current) => previous.status.id === current.status.id,
  lead: (previous, current) => (previous.lead?.id ?? null) === (current.lead?.id ?? null),
  members: (previous, current) =>
    sameLinearProjectIdSet(
      linearProjectEntityIds(previous.members),
      linearProjectEntityIds(current.members)
    ),
  teams: (previous, current) =>
    sameLinearProjectIdSet(
      linearProjectEntityIds(previous.teams),
      linearProjectEntityIds(current.teams)
    ),
  labels: (previous, current) =>
    sameLinearProjectIdSet(
      linearProjectEntityIds(previous.labels),
      linearProjectEntityIds(current.labels)
    ),
  priority: (previous, current) => previous.priority === current.priority,
  startDate: (previous, current) => previous.startDate === current.startDate,
  targetDate: (previous, current) => previous.targetDate === current.targetDate,
  color: (previous, current) => sameLinearProjectColor(previous.color, current.color)
}

/** Requested fields whose value actually moved, in LINEAR_PROJECT_EDITABLE_FIELDS order. */
export function changedLinearProjectFields(
  edits: LinearProjectFieldEdits,
  previous: LinearProjectInternalSnapshot,
  current: LinearProjectInternalSnapshot
): LinearProjectEditableField[] {
  return LINEAR_PROJECT_EDITABLE_FIELDS.filter(
    (field) =>
      edits[EDIT_KEY_BY_FIELD[field]] !== undefined &&
      !SAME_SNAPSHOT_FIELD[field](previous, current)
  )
}

async function readProjectRecord(
  projectId: string,
  workspaceId: string,
  options: { signal?: AbortSignal }
): Promise<LinearProjectWriteRecord> {
  const record = await getProjectByIdForAgent(projectId, workspaceId, options)
  if (!record) {
    throw new LinearWriteFailure('failed', 'Linear project could not be read')
  }
  return record
}

function assertEditable(edits: LinearProjectFieldEdits): void {
  if (!hasProjectFieldEdits(edits)) {
    throw new LinearWriteFailure('failed', 'Linear project edit requires at least one field')
  }
  if (edits.name !== undefined && !edits.name.trim()) {
    throw new LinearWriteFailure('failed', 'Linear project edit requires a non-empty name')
  }
  // Why: status and color are non-null on Project and teams can never be emptied — only members and labels clear.
  if (edits.teamIds !== undefined && edits.teamIds.length === 0) {
    throw new LinearWriteFailure('failed', 'Linear project edit requires at least one team')
  }
}

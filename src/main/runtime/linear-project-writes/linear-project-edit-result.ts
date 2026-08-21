import type {
  LinearProjectFieldSnapshot,
  LinearProjectRef
} from '../../../shared/linear/project-agent-access'
import type {
  LinearProjectEditResult,
  LinearProjectEditableField
} from '../../../shared/linear/project-agent-writes'
import {
  changedLinearProjectFields,
  type LinearProjectFieldEdits
} from '../../linear/project-field-edits'
import {
  toLinearProjectFieldSnapshot,
  type LinearProjectInternalSnapshot
} from '../../linear/project-field-snapshot'

type EditOutcome = {
  project: LinearProjectRef
  workspaceId: string
  requested: LinearProjectEditableField[]
  edits: LinearProjectFieldEdits
  previous: LinearProjectInternalSnapshot
  current: LinearProjectInternalSnapshot
  noop: boolean
}

/** Bounded previous/current for every requested field; `changed` only for the ones that moved. */
export function buildLinearProjectEditResult(outcome: EditOutcome): LinearProjectEditResult {
  const { previous, current, requested } = outcome
  return {
    project: outcome.project,
    changed: changedLinearProjectFields(outcome.edits, previous, current),
    previous: requestedFieldSnapshot(previous, requested),
    current: requestedFieldSnapshot(current, requested),
    meta: { workspaceId: outcome.workspaceId, noop: outcome.noop }
  }
}

/** The published bounded projection, narrowed to the fields the caller asked about. */
function requestedFieldSnapshot(
  fields: LinearProjectInternalSnapshot,
  requested: LinearProjectEditableField[]
): Partial<LinearProjectFieldSnapshot> {
  const projection = toLinearProjectFieldSnapshot(fields)
  const subset: Partial<LinearProjectFieldSnapshot> = {}
  for (const field of requested) {
    Object.assign(subset, { [field]: projection[field] })
  }
  return subset
}

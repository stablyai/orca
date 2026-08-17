import type {
  LinearProjectLabelRef,
  LinearProjectStatusRef
} from '../../shared/linear/project-agent-access'
import { isLinearUuid } from '../../shared/linear/uuid'
import type { LinearClientForWorkspace } from './client'
import { linearError, type LinearAgentAccessError } from './issue-context-errors'
import {
  isAssignableProjectLabel,
  readProjectLabelRows,
  readProjectStatusRows,
  type LinearProjectLabelRow
} from './project-metadata-reads'
import { selectLinearProjectWorkspaces } from './project-workspace-scope'

const WRITE_ACTION = 'a project write'
const STATUS_STEP = 'Run `orca linear project statuses --json` and retry with an exact status name.'
const LABEL_STEP = 'Run `orca linear project labels --json` and retry with an exact label name.'

/** Exact status match for a write; archived statuses stay readable but unassignable. */
export async function resolveProjectStatusForWrite(
  input: string,
  workspaceId: string,
  options: { signal?: AbortSignal } = {}
): Promise<LinearProjectStatusRef> {
  const entry = writeEntry(workspaceId)
  const normalized = input.trim().toLowerCase()
  const rows = (await readProjectStatusRows(entry, options.signal)).filter((row) => !row.archived)
  const matches = rows.filter(
    (row) => row.id.toLowerCase() === normalized || row.name.toLowerCase() === normalized
  )
  if (matches.length === 1) {
    const { id, name, type, color } = matches[0]
    return { id, name, type, color }
  }
  throw linearError(
    'linear_invalid_state',
    matches.length === 0
      ? `No Linear project status exactly matched "${input.trim()}".`
      : `Multiple Linear project statuses exactly matched "${input.trim()}".`,
    {
      statuses: (matches.length === 0 ? rows : matches).map((row) => ({
        id: row.id,
        name: row.name,
        type: row.type
      })),
      nextSteps: [STATUS_STEP]
    }
  )
}

/**
 * Exact label matches for a write. Unlike discovery this pages without a scan
 * cap, because uniqueness has to be proven rather than sampled.
 */
export async function resolveProjectLabelsForWrite(
  inputs: string[],
  workspaceId: string,
  options: { signal?: AbortSignal } = {}
): Promise<LinearProjectLabelRef[]> {
  const entry = writeEntry(workspaceId)
  const resolved = new Map<string, LinearProjectLabelRow>()
  for (const input of dedupeInputs(inputs)) {
    const match = await resolveOneProjectLabel(entry, input, options.signal)
    resolved.set(match.id, match)
  }
  assertNoExclusiveGroupConflict([...resolved.values()])
  return [...resolved.values()].map(({ id, name, color, parent }) => ({ id, name, color, parent }))
}

async function resolveOneProjectLabel(
  entry: LinearClientForWorkspace,
  input: string,
  signal: AbortSignal | undefined
): Promise<LinearProjectLabelRow> {
  const { rows } = await readProjectLabelRows(entry, {
    filter: isLinearUuid(input) ? { id: { eq: input } } : { name: { eqIgnoreCase: input } },
    scanCap: Number.POSITIVE_INFINITY,
    signal
  })
  const assignable = rows.filter(isAssignableProjectLabel)
  if (assignable.length === 1) {
    return assignable[0]
  }
  if (assignable.length > 1) {
    throw labelError(`Multiple Linear project labels exactly matched "${input}".`, assignable)
  }
  if (rows.some((row) => row.isGroup)) {
    throw labelError(`Linear project label "${input}" is a label group and cannot be applied.`, [])
  }
  if (rows.length > 0) {
    throw labelError(
      `Linear project label "${input}" is archived or retired and cannot be applied.`,
      []
    )
  }
  throw labelError(`No Linear project label exactly matched "${input}".`, [])
}

function assertNoExclusiveGroupConflict(rows: LinearProjectLabelRow[]): void {
  const byGroup = new Map<string, LinearProjectLabelRow>()
  for (const row of rows) {
    if (!row.parent) {
      continue
    }
    const sibling = byGroup.get(row.parent.id)
    if (sibling) {
      throw labelError(
        `Linear project label group "${row.parent.name}" allows only one label; "${sibling.name}" and "${row.name}" conflict.`,
        [sibling, row]
      )
    }
    byGroup.set(row.parent.id, row)
  }
}

function dedupeInputs(inputs: string[]): string[] {
  const seen = new Set<string>()
  const unique: string[] = []
  for (const input of inputs) {
    const trimmed = input.trim()
    const key = trimmed.toLowerCase()
    if (!trimmed || seen.has(key)) {
      continue
    }
    seen.add(key)
    unique.push(trimmed)
  }
  return unique
}

function labelError(message: string, candidates: LinearProjectLabelRow[]): LinearAgentAccessError {
  return linearError('linear_invalid_label', message, {
    labels: candidates.map((row) => ({
      id: row.id,
      name: row.name,
      ...(row.parent ? { parent: row.parent } : {})
    })),
    nextSteps: [LABEL_STEP]
  })
}

function writeEntry(workspaceId: string): LinearClientForWorkspace {
  return selectLinearProjectWorkspaces(workspaceId, WRITE_ACTION)[0]
}

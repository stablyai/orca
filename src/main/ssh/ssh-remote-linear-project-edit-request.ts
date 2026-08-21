import {
  LINEAR_PROJECT_DESCRIPTION_CAP,
  LINEAR_PROJECT_NAME_CAP,
  type LinearProjectEditRequest
} from '../../shared/linear/project-agent-writes'
// Why: the flag grammar is the parser layer, so this command reads its clear-flag
// names from there rather than the parser importing this module back.
import {
  LINEAR_PROJECT_EDIT_CLEAR_FLAGS,
  LINEAR_PROJECT_EDIT_COMMAND
} from './ssh-remote-cli-command-grammar'
import {
  RemoteLinearWriteArgumentError,
  assertRemoteProjectTextCap,
  calendarDateFlag,
  hexColorFlag,
  optionalString,
  priorityFlag,
  readRemoteBody,
  rejectAllWorkspaceForWrite,
  remotePositional,
  repeatedString,
  requiredString,
  requiredStringAllowingEmpty,
  validateLinearRemoteArgs
} from './ssh-remote-linear-write-support'

type ParsedRemoteCli = {
  commandPath: string[]
  flags: Map<string, string | boolean>
}

type RemoteFlags = Map<string, string | boolean>

// Why: `write-id` is absent on purpose — `ProjectUpdateInput` has no id, so edits cannot dedup.
const LINEAR_PROJECT_EDIT_FLAGS = new Set([
  'help',
  'json',
  'pairing-code',
  'environment',
  'workspace',
  'id',
  'name',
  'description',
  'content',
  'content-file',
  'status',
  'lead',
  'member',
  'team',
  'label',
  'priority',
  'start-date',
  'target-date',
  'color',
  ...LINEAR_PROJECT_EDIT_CLEAR_FLAGS
])

export function buildRemoteLinearProjectEditRequest(
  parsed: ParsedRemoteCli,
  stdin: string | undefined
): LinearProjectEditRequest {
  validateLinearRemoteArgs(parsed, LINEAR_PROJECT_EDIT_FLAGS, LINEAR_PROJECT_EDIT_COMMAND, 1, 'id')
  rejectAllWorkspaceForWrite(parsed.flags)
  const input =
    optionalString(parsed.flags, 'id') ??
    remotePositional(parsed, LINEAR_PROJECT_EDIT_COMMAND.length)
  if (!input) {
    throw new RemoteLinearWriteArgumentError(
      'invalid_argument',
      'Pass a Linear project UUID, slugId, URL, or exact name positionally or as --id'
    )
  }
  const edits = {
    ...remoteProjectEditName(parsed.flags),
    ...remoteProjectEditProse(parsed.flags, stdin),
    ...remoteProjectEditReferences(parsed.flags),
    ...remoteProjectEditScalars(parsed.flags)
  }
  if (Object.keys(edits).length === 0) {
    throw new RemoteLinearWriteArgumentError(
      'invalid_argument',
      'Pass at least one field flag or --clear-* flag to edit a Linear project'
    )
  }
  // Why: references travel as user input; the host that owns the Linear token resolves them.
  return { input, ...edits, workspaceId: optionalString(parsed.flags, 'workspace') }
}

function remoteProjectEditName(flags: RemoteFlags): { name?: string } {
  if (!flags.has('name')) {
    return {}
  }
  const name = requiredString(flags, 'name').trim()
  if (!name) {
    throw new RemoteLinearWriteArgumentError('invalid_argument', '--name must not be blank')
  }
  assertRemoteProjectTextCap(name, LINEAR_PROJECT_NAME_CAP, 'name')
  return { name }
}

/** Prose is never trimmed: `--description=` and `--clear-description` both mean the empty summary. */
function remoteProjectEditProse(
  flags: RemoteFlags,
  stdin: string | undefined
): { description?: string; content?: string | null } {
  const description = clearRequested(flags, 'clear-description', ['description'])
    ? ''
    : flags.has('description')
      ? requiredStringAllowingEmpty(flags, 'description')
      : undefined
  if (description !== undefined) {
    assertRemoteProjectTextCap(description, LINEAR_PROJECT_DESCRIPTION_CAP, 'description')
  }
  const content = clearRequested(flags, 'clear-content', ['content', 'content-file'])
    ? null
    : readRemoteBody(flags, false, stdin, { value: 'content', file: 'content-file' })
  return {
    ...(description !== undefined ? { description } : {}),
    ...(content !== undefined ? { content } : {})
  }
}

/** Repeated `--member`, `--team` and `--label` REPLACE the whole collection. */
function remoteProjectEditReferences(flags: RemoteFlags): {
  status?: string
  lead?: string | null
  members?: string[]
  teams?: string[]
  labels?: string[]
} {
  const lead = clearRequested(flags, 'clear-lead', ['lead'])
    ? null
    : flags.has('lead')
      ? requiredString(flags, 'lead')
      : undefined
  const members = remoteProjectEditCollection(flags, 'member', 'clear-members')
  const labels = remoteProjectEditCollection(flags, 'label', 'clear-labels')
  return {
    ...(flags.has('status') ? { status: requiredString(flags, 'status') } : {}),
    ...(lead !== undefined ? { lead } : {}),
    ...(members !== undefined ? { members } : {}),
    ...(labels !== undefined ? { labels } : {}),
    ...(flags.has('team')
      ? {
          teams: replacementCollection(
            flags,
            'team',
            '--team replaces the whole collection and needs at least one value; a project edit cannot remove every team'
          )
        }
      : {})
  }
}

function remoteProjectEditCollection(
  flags: RemoteFlags,
  valueFlag: 'member' | 'label',
  clearFlag: 'clear-members' | 'clear-labels'
): string[] | undefined {
  if (clearRequested(flags, clearFlag, [valueFlag])) {
    return []
  }
  if (!flags.has(valueFlag)) {
    return undefined
  }
  return replacementCollection(
    flags,
    valueFlag,
    `--${valueFlag} replaces the whole collection and needs at least one value; use --${clearFlag} to empty it`
  )
}

/** Spread per flag so priority `none` (0) survives instead of being dropped as falsy. */
function remoteProjectEditScalars(flags: RemoteFlags): {
  priority?: number
  startDate?: string | null
  targetDate?: string | null
  color?: string
} {
  const startDate = remoteProjectEditDate(flags, 'start-date', 'clear-start-date')
  const targetDate = remoteProjectEditDate(flags, 'target-date', 'clear-target-date')
  return {
    ...(flags.has('priority') ? { priority: priorityFlag(flags, 'priority') } : {}),
    ...(startDate !== undefined ? { startDate } : {}),
    ...(targetDate !== undefined ? { targetDate } : {}),
    ...(flags.has('color') ? { color: hexColorFlag(flags, 'color') } : {})
  }
}

function remoteProjectEditDate(
  flags: RemoteFlags,
  valueFlag: 'start-date' | 'target-date',
  clearFlag: 'clear-start-date' | 'clear-target-date'
): string | null | undefined {
  if (clearRequested(flags, clearFlag, [valueFlag])) {
    return null
  }
  return flags.has(valueFlag) ? calendarDateFlag(flags, valueFlag) : undefined
}

function replacementCollection(flags: RemoteFlags, name: string, emptyMessage: string): string[] {
  const values = [...new Set(repeatedString(flags, name))]
  if (values.length === 0) {
    throw new RemoteLinearWriteArgumentError('invalid_argument', emptyMessage)
  }
  return values
}

/** A `--clear-*` flag is boolean-only and mutually exclusive with every flag that sets the field. */
function clearRequested(flags: RemoteFlags, clearFlag: string, valueFlags: string[]): boolean {
  if (!flags.has(clearFlag)) {
    return false
  }
  if (flags.get(clearFlag) !== true) {
    throw new RemoteLinearWriteArgumentError('invalid_argument', `--${clearFlag} takes no value`)
  }
  const conflict = valueFlags.find((flag) => flags.has(flag))
  if (conflict) {
    throw new RemoteLinearWriteArgumentError(
      'invalid_argument',
      `Use either --${conflict} or --${clearFlag}, not both`
    )
  }
  return true
}

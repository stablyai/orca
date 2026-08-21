import {
  LINEAR_PROJECT_NAME_CAP,
  type LinearProjectEditRequest
} from '../shared/linear/project-agent-writes'
import { getRepeatedStringFlag, getRequiredStringFlag } from './flags'
import {
  assertProjectTextCap,
  buildProjectTargetRequest,
  getProjectColor,
  readLinearContent,
  readLinearProjectDescription
} from './linear-project-request-builders'
import {
  getDueDateFlag,
  getPriorityFlag,
  rejectAllWorkspaceForWrite
} from './linear-request-builders'
import { RuntimeClientError } from './runtime-client'

type LinearProjectEdits = Omit<LinearProjectEditRequest, 'input' | 'workspaceId'>

const EDIT_FIELD_FLAGS = [
  'name',
  'description',
  'clear-description',
  'content',
  'content-file',
  'clear-content',
  'status',
  'lead',
  'clear-lead',
  'member',
  'clear-members',
  'team',
  'label',
  'clear-labels',
  'priority',
  'start-date',
  'clear-start-date',
  'target-date',
  'clear-target-date',
  'color'
]

/** Each clear flag with the value flags it may never accompany. */
const CLEAR_FLAG_CONFLICTS: [string, string[]][] = [
  ['clear-description', ['description']],
  ['clear-content', ['content', 'content-file']],
  ['clear-lead', ['lead']],
  ['clear-members', ['member']],
  ['clear-labels', ['label']],
  ['clear-start-date', ['start-date']],
  ['clear-target-date', ['target-date']]
]

/**
 * References travel as user input; the host that owns the Linear token resolves
 * them. Requested keys are the whole contract: a key that is absent here is a
 * field the edit never touches, so only requested keys are ever set.
 */
export async function buildProjectEditRequest(
  flags: Map<string, string | boolean>,
  cwd: string
): Promise<LinearProjectEditRequest> {
  // Why: an edit is a write, so `--workspace all` fails with the write wording every
  // other project write uses rather than the read wording in the shared target builder.
  rejectAllWorkspaceForWrite(flags)
  const target = buildProjectTargetRequest(flags)
  if (!EDIT_FIELD_FLAGS.some((flag) => flags.has(flag))) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Pass at least one field flag or --clear-* flag to edit a Linear project'
    )
  }
  rejectValuedClearFlags(flags)
  rejectClearConflicts(flags)
  const edits = readProjectFieldEdits(flags)
  // Why: prose is read last so a usage error never consumes piped stdin.
  if (flags.has('clear-description')) {
    edits.description = ''
  } else if (flags.has('description')) {
    edits.description = readLinearProjectDescription(flags)
  }
  if (flags.has('clear-content')) {
    edits.content = null
  } else if (flags.has('content') || flags.has('content-file')) {
    edits.content = await readLinearContent(flags, cwd)
  }
  return { ...target, ...edits }
}

/**
 * `--flag=value` is parsed before the boolean lookup, so `--clear-content=false`
 * would otherwise land as the string `'false'` and still clear the field. Clears
 * are destructive, so a value here is a usage error rather than a silent yes.
 */
function rejectValuedClearFlags(flags: Map<string, string | boolean>): void {
  for (const [clearFlag] of CLEAR_FLAG_CONFLICTS) {
    if (flags.has(clearFlag) && flags.get(clearFlag) !== true) {
      throw new RuntimeClientError('invalid_argument', `--${clearFlag} takes no value`)
    }
  }
}

function rejectClearConflicts(flags: Map<string, string | boolean>): void {
  for (const [clearFlag, valueFlags] of CLEAR_FLAG_CONFLICTS) {
    if (!flags.has(clearFlag)) {
      continue
    }
    const conflict = valueFlags.find((valueFlag) => flags.has(valueFlag))
    if (conflict) {
      throw new RuntimeClientError(
        'invalid_argument',
        `Use either --${conflict} or --${clearFlag}, not both`
      )
    }
  }
}

function readProjectFieldEdits(flags: Map<string, string | boolean>): LinearProjectEdits {
  const edits: LinearProjectEdits = { ...readProjectCollectionEdits(flags) }
  if (flags.has('name')) {
    const name = getRequiredStringFlag(flags, 'name').trim()
    if (name.length === 0) {
      throw new RuntimeClientError('invalid_argument', '--name must not be blank')
    }
    assertProjectTextCap(name, LINEAR_PROJECT_NAME_CAP, 'name')
    edits.name = name
  }
  if (flags.has('status')) {
    edits.status = getRequiredStringFlag(flags, 'status')
  }
  if (flags.has('color')) {
    edits.color = getProjectColor(flags)
  }
  if (flags.has('priority')) {
    edits.priority = getPriorityFlag(flags, 'priority')
  }
  edits.lead = readClearableText(flags, 'lead')
  edits.startDate = readClearableDate(flags, 'start-date')
  edits.targetDate = readClearableDate(flags, 'target-date')
  return dropUnrequestedFields(edits)
}

/**
 * Repeating a collection flag REPLACES the whole collection, so an empty
 * replacement is a usage error: emptying members or labels needs the explicit
 * clear flag, and a project can never be left with no team.
 */
function readProjectCollectionEdits(flags: Map<string, string | boolean>): LinearProjectEdits {
  const edits: LinearProjectEdits = {}
  if (flags.has('clear-members')) {
    edits.members = []
  } else if (flags.has('member')) {
    edits.members = readReplacementCollection(flags, 'member', 'clear-members')
  }
  if (flags.has('clear-labels')) {
    edits.labels = []
  } else if (flags.has('label')) {
    edits.labels = readReplacementCollection(flags, 'label', 'clear-labels')
  }
  if (flags.has('team')) {
    edits.teams = readReplacementCollection(flags, 'team')
  }
  return edits
}

function readReplacementCollection(
  flags: Map<string, string | boolean>,
  name: string,
  clearFlag?: string
): string[] {
  const values = [...new Set(getRepeatedStringFlag(flags, name))]
  if (values.length === 0) {
    const recovery = clearFlag
      ? `use --${clearFlag} to empty it`
      : 'a project edit cannot remove every team'
    throw new RuntimeClientError(
      'invalid_argument',
      `--${name} replaces the whole collection and needs at least one value; ${recovery}`
    )
  }
  return values
}

function readClearableText(
  flags: Map<string, string | boolean>,
  name: string
): string | null | undefined {
  if (flags.has(`clear-${name}`)) {
    return null
  }
  return flags.has(name) ? getRequiredStringFlag(flags, name) : undefined
}

function readClearableDate(
  flags: Map<string, string | boolean>,
  name: 'start-date' | 'target-date'
): string | null | undefined {
  if (flags.has(`clear-${name}`)) {
    return null
  }
  return flags.has(name) ? getDueDateFlag(flags, name) : undefined
}

/** `undefined` means "not requested", and the wire contract keys off presence. */
function dropUnrequestedFields(edits: LinearProjectEdits): LinearProjectEdits {
  return Object.fromEntries(
    Object.entries(edits).filter(([, value]) => value !== undefined)
  ) as LinearProjectEdits
}

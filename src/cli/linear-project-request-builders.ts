import type {
  LinearProjectShowRequest,
  LinearProjectTargetRequest,
  LinearProjectUpdateHealth,
  LinearProjectWorkspaceReadRequest
} from '../shared/linear/project-agent-access'
import {
  clampLinearProjectMetadataLimit,
  clampLinearProjectUpdatesLimit
} from '../shared/linear/project-agent-access'
import type {
  LinearProjectCreateRequest,
  LinearProjectUpdateAddRequest
} from '../shared/linear/project-agent-writes'
import {
  LINEAR_PROJECT_DESCRIPTION_CAP,
  LINEAR_PROJECT_NAME_CAP,
  LINEAR_PROJECT_UPDATE_HEALTH_CLI_VALUES,
  linearProjectTextCapError,
  toLinearProjectUpdateHealth
} from '../shared/linear/project-agent-writes'
import { isLinearUuidV4 } from '../shared/linear/uuid'
import {
  getOptionalPositiveIntegerFlag,
  getOptionalStringFlag,
  getRepeatedStringFlag,
  getRequiredStringFlag
} from './flags'
import {
  getDueDateFlag,
  getOptionalWriteId,
  getPriorityFlag,
  getRequiredRepeatedStringFlag,
  readLinearBody,
  rejectAllWorkspaceForWrite
} from './linear-request-builders'
import { RuntimeClientError } from './runtime-client'

const PROJECT_COLOR_PATTERN = /^#[0-9A-Fa-f]{6}$/

/**
 * Project targets are deliberately not routed through `buildWriteTargetRequest`:
 * that builder raises issue-specific errors and attaches current-issue context,
 * and there is no `--current` project inference.
 */
export function buildProjectTargetRequest(
  flags: Map<string, string | boolean>
): LinearProjectTargetRequest {
  const workspaceId = getOptionalStringFlag(flags, 'workspace')
  if (workspaceId === 'all') {
    throw new RuntimeClientError(
      'linear_invalid_workspace',
      '--workspace all is not valid for a single Linear project'
    )
  }
  const input = getOptionalStringFlag(flags, 'id')
  if (!input) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Pass a Linear project UUID, slugId, URL, or exact name positionally or as --id'
    )
  }
  return { input, workspaceId }
}

export function buildProjectShowRequest(
  flags: Map<string, string | boolean>
): LinearProjectShowRequest {
  const updates = flags.get('updates') === true
  if (flags.has('updates-limit') && !updates) {
    throw new RuntimeClientError('invalid_argument', '--updates-limit requires --updates')
  }
  const requestedLimit = getOptionalPositiveIntegerFlag(flags, 'updates-limit')
  return {
    ...buildProjectTargetRequest(flags),
    updates,
    ...(updates ? { updatesLimit: clampLinearProjectUpdatesLimit(requestedLimit) } : {})
  }
}

export function buildProjectWorkspaceReadRequest(
  flags: Map<string, string | boolean>
): LinearProjectWorkspaceReadRequest {
  return {
    query: getOptionalStringFlag(flags, 'query'),
    limit: clampLinearProjectMetadataLimit(getOptionalPositiveIntegerFlag(flags, 'limit')),
    workspaceId: getOptionalStringFlag(flags, 'workspace')
  }
}

/**
 * Target, write id and health are validated before the body is read so a usage
 * error never consumes a piped stdin the caller would have to produce again.
 */
export async function buildProjectUpdateAddRequest(
  flags: Map<string, string | boolean>,
  cwd: string
): Promise<LinearProjectUpdateAddRequest> {
  // Why: posting an update is a write, so `--workspace all` fails with the write wording
  // rather than the read wording in the shared target builder.
  rejectAllWorkspaceForWrite(flags)
  const target = buildProjectTargetRequest(flags)
  const writeId = getOptionalWriteId(flags)
  const health = readProjectUpdateHealth(flags)
  const body = await readLinearBody(flags, cwd, {
    required: true,
    normalize: normalizeLinearProjectLineEndings
  })
  if (body.length === 0) {
    throw new RuntimeClientError('invalid_argument', 'Linear project update body must not be empty')
  }
  return {
    ...target,
    body,
    ...(health ? { health } : {}),
    isDiffHidden: flags.get('hide-diff') === true,
    writeId
  }
}

/**
 * References travel as user input: the host that owns the Linear token resolves
 * teams, users, statuses and labels, so the CLI never pre-resolves them.
 * Validation order keeps a usage error from consuming piped stdin.
 */
export async function buildProjectCreateRequest(
  flags: Map<string, string | boolean>,
  cwd: string
): Promise<LinearProjectCreateRequest> {
  rejectAllWorkspaceForWrite(flags)
  const name = getRequiredStringFlag(flags, 'name').trim()
  if (name.length === 0) {
    throw new RuntimeClientError('invalid_argument', '--name must not be blank')
  }
  assertProjectTextCap(name, LINEAR_PROJECT_NAME_CAP, 'name')
  const teams = uniqueReferences(getRequiredRepeatedStringFlag(flags, 'team'))
  const writeId = getProjectCreateWriteId(flags)
  const priority = flags.has('priority') ? getPriorityFlag(flags, 'priority') : undefined
  const startDate = flags.has('start-date') ? getDueDateFlag(flags, 'start-date') : undefined
  const targetDate = flags.has('target-date') ? getDueDateFlag(flags, 'target-date') : undefined
  const color = getProjectColor(flags)
  // Why: the description has no file form, so reading and capping it here still
  // precedes the content read that may consume a piped stdin.
  const description = readLinearProjectDescription(flags)
  return {
    name,
    teams,
    description,
    content: await readLinearContent(flags, cwd),
    status: readOptionalReference(flags, 'status'),
    lead: readOptionalReference(flags, 'lead'),
    members: readOptionalReferences(flags, 'member'),
    labels: readOptionalReferences(flags, 'label'),
    priority,
    startDate,
    targetDate,
    color,
    writeId,
    workspaceId: getOptionalStringFlag(flags, 'workspace')
  }
}

/** `--content` and `--content-file` are exclusive; the file form accepts `-` for stdin. */
export async function readLinearContent(
  flags: Map<string, string | boolean>,
  cwd: string
): Promise<string | undefined> {
  const hasContent = flags.has('content')
  const hasContentFile = flags.has('content-file')
  if (hasContent && hasContentFile) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Use either --content or --content-file, not both'
    )
  }
  if (!hasContent && !hasContentFile) {
    return undefined
  }
  const flag = hasContent ? 'content' : 'content-file'
  const value = flags.get(flag)
  // Why: `--content=` is meaningful empty prose, but an empty file path is not.
  if (typeof value !== 'string' || (hasContentFile && value.length === 0)) {
    throw new RuntimeClientError('invalid_argument', `--${flag} requires a value`)
  }
  return await readLinearProse(cwd, hasContent ? 'body' : 'body-file', value, CONTENT_LABELS)
}

/** `--description` is short prose, so it has no file form; empty text stays meaningful. */
export function readLinearProjectDescription(
  flags: Map<string, string | boolean>
): string | undefined {
  if (!flags.has('description')) {
    return undefined
  }
  const value = flags.get('description')
  if (typeof value !== 'string') {
    throw new RuntimeClientError('invalid_argument', '--description requires a value')
  }
  // Why: the shared reader caps at the 65,000-char body limit, so the 255-char
  // description cap has to be checked first or the error names the wrong limit.
  const description = normalizeLinearProjectLineEndings(value)
  assertProjectTextCap(description, LINEAR_PROJECT_DESCRIPTION_CAP, 'description')
  return description
}

/** Linear enforces both caps server-side; failing locally keeps the error actionable. */
export function assertProjectTextCap(
  value: string,
  cap: number,
  flag: 'name' | 'description'
): void {
  const failure = linearProjectTextCapError(value, cap, flag)
  if (failure) {
    throw new RuntimeClientError('invalid_argument', failure)
  }
}

/** Reuses the shared body reader so every prose flag shares one stdin path and cap. */
function readLinearProse(
  cwd: string,
  source: 'body' | 'body-file',
  value: string,
  labels: { value: string; file: string; noun: string }
): Promise<string> {
  return readLinearBody(new Map<string, string | boolean>([[source, value]]), cwd, {
    required: true,
    normalize: normalizeLinearProjectLineEndings,
    labels
  })
}

const CONTENT_LABELS = { value: 'content', file: 'content-file', noun: 'content' }

/** Project creation pins `ProjectCreateInput.id`, which Linear documents as UUID v4. */
function getProjectCreateWriteId(flags: Map<string, string | boolean>): string | undefined {
  if (!flags.has('write-id')) {
    return undefined
  }
  const writeId = getRequiredStringFlag(flags, 'write-id')
  if (!isLinearUuidV4(writeId)) {
    throw new RuntimeClientError(
      'linear_invalid_write_id',
      '--write-id must be a UUID v4 for Linear project create'
    )
  }
  return writeId
}

export function getProjectColor(flags: Map<string, string | boolean>): string | undefined {
  if (!flags.has('color')) {
    return undefined
  }
  const color = getRequiredStringFlag(flags, 'color')
  if (!PROJECT_COLOR_PATTERN.test(color)) {
    throw new RuntimeClientError(
      'invalid_argument',
      '--color must be #RRGGBB, quoted so the shell keeps the leading #'
    )
  }
  return color
}

/** Why: a repeated reference costs one lookup each; the host dedupes resolved ids anyway. */
function uniqueReferences(values: string[]): string[] {
  return [...new Set(values)]
}

/**
 * Why: `--lead=` from an unset shell variable parses to an absent flag, and silently
 * creating the project without that lead is worse than failing — `edit` rejects it.
 */
function readOptionalReference(
  flags: Map<string, string | boolean>,
  name: string
): string | undefined {
  if (!flags.has(name)) {
    return undefined
  }
  const value = getOptionalStringFlag(flags, name)
  if (value === undefined) {
    throw new RuntimeClientError('invalid_argument', `--${name} needs a value`)
  }
  return value
}

/**
 * Why: `--member=` parses to no values, and silently creating the project without
 * that member is worse than failing — `edit` already rejects the same input.
 */
function readOptionalReferences(
  flags: Map<string, string | boolean>,
  name: string
): string[] | undefined {
  if (!flags.has(name)) {
    return undefined
  }
  const values = uniqueReferences(getRepeatedStringFlag(flags, name))
  if (values.length === 0) {
    throw new RuntimeClientError('invalid_argument', `--${name} needs at least one value`)
  }
  return values
}

/** CRLF and lone CR become LF; no trimming and no Unicode normalization. */
function normalizeLinearProjectLineEndings(value: string): string {
  return value.replace(/\r\n?/g, '\n')
}

function readProjectUpdateHealth(
  flags: Map<string, string | boolean>
): LinearProjectUpdateHealth | undefined {
  if (!flags.has('health')) {
    return undefined
  }
  const requested = flags.get('health')
  const health = typeof requested === 'string' ? toLinearProjectUpdateHealth(requested) : null
  if (!health) {
    throw new RuntimeClientError(
      'invalid_argument',
      `--health must be one of ${LINEAR_PROJECT_UPDATE_HEALTH_CLI_VALUES.join(', ')}`
    )
  }
  return health
}

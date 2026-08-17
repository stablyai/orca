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
  LINEAR_PROJECT_UPDATE_HEALTH_CLI_VALUES,
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
  const teams = uniqueReferences(getRequiredRepeatedStringFlag(flags, 'team'))
  const writeId = getProjectCreateWriteId(flags)
  const priority = flags.has('priority') ? getPriorityFlag(flags, 'priority') : undefined
  const startDate = flags.has('start-date') ? getDueDateFlag(flags, 'start-date') : undefined
  const targetDate = flags.has('target-date') ? getDueDateFlag(flags, 'target-date') : undefined
  const color = getProjectColor(flags)
  return {
    name,
    teams,
    description: await readLinearProjectDescription(flags, cwd),
    content: await readLinearContent(flags, cwd),
    status: getOptionalStringFlag(flags, 'status'),
    lead: getOptionalStringFlag(flags, 'lead'),
    members: flags.has('member')
      ? uniqueReferences(getRepeatedStringFlag(flags, 'member'))
      : undefined,
    labels: flags.has('label')
      ? uniqueReferences(getRepeatedStringFlag(flags, 'label'))
      : undefined,
    priority,
    startDate,
    targetDate,
    color,
    icon: getOptionalStringFlag(flags, 'icon'),
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
  return await readLinearProse(cwd, hasContent ? 'body' : 'body-file', value)
}

async function readLinearProjectDescription(
  flags: Map<string, string | boolean>,
  cwd: string
): Promise<string | undefined> {
  if (!flags.has('description')) {
    return undefined
  }
  const value = flags.get('description')
  if (typeof value !== 'string') {
    throw new RuntimeClientError('invalid_argument', '--description requires a value')
  }
  return await readLinearProse(cwd, 'body', value)
}

/** Reuses the shared body reader so every prose flag shares one stdin path and cap. */
function readLinearProse(
  cwd: string,
  source: 'body' | 'body-file',
  value: string
): Promise<string> {
  return readLinearBody(new Map<string, string | boolean>([[source, value]]), cwd, {
    required: true,
    normalize: normalizeLinearProjectLineEndings
  })
}

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

function getProjectColor(flags: Map<string, string | boolean>): string | undefined {
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

/** CRLF and lone CR become LF; no trimming and no Unicode normalization. */
export function normalizeLinearProjectLineEndings(value: string): string {
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

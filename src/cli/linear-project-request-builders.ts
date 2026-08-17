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
import type { LinearProjectUpdateAddRequest } from '../shared/linear/project-agent-writes'
import {
  LINEAR_PROJECT_UPDATE_HEALTH_CLI_VALUES,
  toLinearProjectUpdateHealth
} from '../shared/linear/project-agent-writes'
import { getOptionalPositiveIntegerFlag, getOptionalStringFlag } from './flags'
import { getOptionalWriteId, readLinearBody } from './linear-request-builders'
import { RuntimeClientError } from './runtime-client'

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

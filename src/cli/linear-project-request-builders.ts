import type {
  LinearProjectShowRequest,
  LinearProjectTargetRequest,
  LinearProjectWorkspaceReadRequest
} from '../shared/linear/project-agent-access'
import {
  clampLinearProjectMetadataLimit,
  clampLinearProjectUpdatesLimit
} from '../shared/linear/project-agent-access'
import { getOptionalPositiveIntegerFlag, getOptionalStringFlag } from './flags'
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

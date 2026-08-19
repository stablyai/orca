import {
  clampLinearProjectMetadataLimit,
  clampLinearProjectUpdatesLimit,
  type LinearProjectShowRequest,
  type LinearProjectWorkspaceReadRequest
} from '../../shared/linear/agent-access'
import type { RpcDispatcher } from '../runtime/rpc/dispatcher'
import type { RpcResponse } from '../runtime/rpc/core'
import { RemoteCliArgumentError, type ParsedRemoteCli } from './ssh-remote-cli-argument-error'
import {
  LINEAR_PROJECT_LABELS_FLAGS,
  LINEAR_PROJECT_SHOW_FLAGS,
  LINEAR_PROJECT_STATUSES_FLAGS
} from './ssh-remote-linear-read-flags'
import {
  callRemoteLinearProjectMethod,
  isRemoteProjectCommand,
  optionalRemoteProjectPositiveInteger,
  optionalRemoteProjectString,
  remoteProjectPositional,
  validateRemoteProjectArgs
} from './ssh-remote-linear-project-read-args'

export async function tryDispatchRemoteLinearProjectReadCli(
  dispatcher: RpcDispatcher,
  parsed: ParsedRemoteCli
): Promise<RpcResponse | null> {
  if (isRemoteProjectCommand(parsed, 'show')) {
    validateRemoteProjectArgs(parsed, {
      command: ['linear', 'project', 'show'],
      allowedFlags: LINEAR_PROJECT_SHOW_FLAGS,
      positionalFlag: 'id',
      maxPositionals: 1
    })
    return await callRemoteLinearProjectMethod(
      dispatcher,
      'linear.agentProjectShow',
      buildRemoteLinearProjectShowRequest(parsed)
    )
  }
  if (isRemoteProjectCommand(parsed, 'statuses')) {
    return await dispatchRemoteLinearProjectMetadata(
      dispatcher,
      parsed,
      ['linear', 'project', 'statuses'],
      LINEAR_PROJECT_STATUSES_FLAGS,
      'linear.agentProjectStatuses'
    )
  }
  if (isRemoteProjectCommand(parsed, 'labels')) {
    return await dispatchRemoteLinearProjectMetadata(
      dispatcher,
      parsed,
      ['linear', 'project', 'labels'],
      LINEAR_PROJECT_LABELS_FLAGS,
      'linear.agentProjectLabels'
    )
  }
  return null
}

async function dispatchRemoteLinearProjectMetadata(
  dispatcher: RpcDispatcher,
  parsed: ParsedRemoteCli,
  command: string[],
  allowedFlags: ReadonlySet<string>,
  method: string
): Promise<RpcResponse> {
  validateRemoteProjectArgs(parsed, {
    command,
    allowedFlags,
    positionalFlag: 'query',
    maxPositionals: 0
  })
  const request: LinearProjectWorkspaceReadRequest = {
    query: optionalRemoteProjectString(parsed.flags, 'query'),
    limit: clampLinearProjectMetadataLimit(
      optionalRemoteProjectPositiveInteger(parsed.flags, 'limit')
    ),
    workspaceId: optionalRemoteProjectString(parsed.flags, 'workspace')
  }
  return await callRemoteLinearProjectMethod(dispatcher, method, request)
}

function buildRemoteLinearProjectShowRequest(parsed: ParsedRemoteCli): LinearProjectShowRequest {
  const updates = parsed.flags.get('updates') === true
  if (parsed.flags.has('updates-limit') && !updates) {
    throw new RemoteCliArgumentError('invalid_argument', '--updates-limit requires --updates')
  }
  const workspaceId = optionalRemoteProjectString(parsed.flags, 'workspace')
  if (workspaceId === 'all') {
    throw new RemoteCliArgumentError(
      'linear_invalid_workspace',
      '--workspace all is not valid for project show'
    )
  }
  const input =
    optionalRemoteProjectString(parsed.flags, 'id') ?? remoteProjectPositional(parsed, 3)
  if (!input) {
    throw new RemoteCliArgumentError(
      'invalid_argument',
      'Pass a project as a positional argument or --id <project>'
    )
  }
  const requestedLimit = optionalRemoteProjectPositiveInteger(parsed.flags, 'updates-limit')
  return {
    input,
    workspaceId,
    updates,
    ...(updates ? { updatesLimit: clampLinearProjectUpdatesLimit(requestedLimit) } : {})
  }
}

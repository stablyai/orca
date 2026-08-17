import type { RpcResponse } from '../runtime/rpc/core'
import type { RpcDispatcher } from '../runtime/rpc/dispatcher'
import {
  LINEAR_PROJECT_UPDATE_HEALTH_CLI_VALUES,
  toLinearProjectUpdateHealth,
  type LinearProjectUpdateAddRequest
} from '../../shared/linear/project-agent-writes'
import type { LinearProjectUpdateHealth } from '../../shared/linear/project-agent-access'
import {
  RemoteLinearWriteArgumentError,
  call,
  isRemoteCommand,
  optionalString,
  optionalWriteId,
  readRemoteBody,
  rejectAllWorkspaceForWrite,
  remotePositional,
  requiredString,
  validateLinearRemoteArgs
} from './ssh-remote-linear-write-support'

type ParsedRemoteCli = {
  commandPath: string[]
  flags: Map<string, string | boolean>
}

const LINEAR_PROJECT_WRITE_FLAGS = [
  'help',
  'json',
  'pairing-code',
  'environment',
  'workspace',
  'id'
]
const LINEAR_PROJECT_UPDATE_ADD_COMMAND = ['linear', 'project', 'update', 'add']
const LINEAR_PROJECT_UPDATE_ADD_FLAGS = new Set([
  ...LINEAR_PROJECT_WRITE_FLAGS,
  'body',
  'body-file',
  'health',
  'hide-diff',
  'write-id'
])

export async function tryDispatchRemoteLinearProjectWriteCli(
  dispatcher: RpcDispatcher,
  parsed: ParsedRemoteCli,
  stdin?: string
): Promise<RpcResponse | null> {
  if (isRemoteCommand(parsed, ...LINEAR_PROJECT_UPDATE_ADD_COMMAND)) {
    return await call(
      dispatcher,
      'linear.agentProjectUpdateAdd',
      buildRemoteLinearProjectUpdateAddRequest(parsed, stdin)
    )
  }
  return null
}

function buildRemoteLinearProjectUpdateAddRequest(
  parsed: ParsedRemoteCli,
  stdin: string | undefined
): LinearProjectUpdateAddRequest {
  validateLinearRemoteArgs(
    parsed,
    LINEAR_PROJECT_UPDATE_ADD_FLAGS,
    LINEAR_PROJECT_UPDATE_ADD_COMMAND,
    1,
    'id'
  )
  rejectAllWorkspaceForWrite(parsed.flags)
  const input =
    optionalString(parsed.flags, 'id') ??
    remotePositional(parsed, LINEAR_PROJECT_UPDATE_ADD_COMMAND.length)
  if (!input) {
    throw new RemoteLinearWriteArgumentError(
      'invalid_argument',
      'Pass a project as a positional argument or --id <project>'
    )
  }
  const body = readRemoteBody(parsed.flags, true, stdin)
  if (!body) {
    throw new RemoteLinearWriteArgumentError(
      'invalid_argument',
      'Linear project update body must not be empty'
    )
  }
  const health = remoteProjectUpdateHealth(parsed.flags)
  return {
    input,
    workspaceId: optionalString(parsed.flags, 'workspace'),
    body,
    ...(health ? { health } : {}),
    isDiffHidden: parsed.flags.get('hide-diff') === true,
    writeId: optionalWriteId(parsed.flags)
  }
}

function remoteProjectUpdateHealth(
  flags: Map<string, string | boolean>
): LinearProjectUpdateHealth | undefined {
  if (!flags.has('health')) {
    return undefined
  }
  const health = toLinearProjectUpdateHealth(requiredString(flags, 'health'))
  if (!health) {
    throw new RemoteLinearWriteArgumentError(
      'invalid_argument',
      `--health must be ${LINEAR_PROJECT_UPDATE_HEALTH_CLI_VALUES.join(', ')}`
    )
  }
  return health
}

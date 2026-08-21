import type { RpcResponse } from '../runtime/rpc/core'
import type { RpcDispatcher } from '../runtime/rpc/dispatcher'
import {
  LINEAR_PROJECT_DESCRIPTION_CAP,
  LINEAR_PROJECT_NAME_CAP,
  LINEAR_PROJECT_UPDATE_HEALTH_CLI_VALUES,
  toLinearProjectUpdateHealth,
  type LinearProjectCreateRequest,
  type LinearProjectUpdateAddRequest
} from '../../shared/linear/project-agent-writes'
import type { LinearProjectUpdateHealth } from '../../shared/linear/project-agent-access'
import { LINEAR_PROJECT_EDIT_COMMAND } from './ssh-remote-cli-command-grammar'
import { buildRemoteLinearProjectEditRequest } from './ssh-remote-linear-project-edit-request'
import {
  RemoteLinearWriteArgumentError,
  assertRemoteProjectTextCap,
  calendarDateFlag,
  call,
  hexColorFlag,
  isRemoteCommand,
  optionalString,
  optionalWriteId,
  optionalWriteIdV4,
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

const LINEAR_PROJECT_WRITE_FLAGS = ['help', 'json', 'pairing-code', 'environment', 'workspace']
const LINEAR_PROJECT_TARGET_WRITE_FLAGS = [...LINEAR_PROJECT_WRITE_FLAGS, 'id']
const LINEAR_PROJECT_UPDATE_ADD_COMMAND = ['linear', 'project', 'update', 'add']
const LINEAR_PROJECT_UPDATE_ADD_FLAGS = new Set([
  ...LINEAR_PROJECT_TARGET_WRITE_FLAGS,
  'body',
  'body-file',
  'health',
  'hide-diff',
  'write-id'
])
const LINEAR_PROJECT_CREATE_COMMAND = ['linear', 'project', 'create']
const LINEAR_PROJECT_CREATE_FLAGS = new Set([
  ...LINEAR_PROJECT_WRITE_FLAGS,
  'name',
  'team',
  'description',
  'content',
  'content-file',
  'status',
  'lead',
  'member',
  'label',
  'priority',
  'start-date',
  'target-date',
  'color',
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
  if (isRemoteCommand(parsed, ...LINEAR_PROJECT_CREATE_COMMAND)) {
    return await call(
      dispatcher,
      'linear.agentProjectCreate',
      buildRemoteLinearProjectCreateRequest(parsed, stdin)
    )
  }
  if (isRemoteCommand(parsed, ...LINEAR_PROJECT_EDIT_COMMAND)) {
    return await call(
      dispatcher,
      'linear.agentProjectEdit',
      buildRemoteLinearProjectEditRequest(parsed, stdin)
    )
  }
  return null
}

function buildRemoteLinearProjectCreateRequest(
  parsed: ParsedRemoteCli,
  stdin: string | undefined
): LinearProjectCreateRequest {
  validateLinearRemoteArgs(
    parsed,
    LINEAR_PROJECT_CREATE_FLAGS,
    LINEAR_PROJECT_CREATE_COMMAND,
    0,
    'id'
  )
  rejectAllWorkspaceForWrite(parsed.flags)
  // Why: same wording as the local CLI so an agent sees one message per failure, not one per transport.
  if (!parsed.flags.has('name')) {
    throw new RemoteLinearWriteArgumentError('invalid_argument', 'Missing required --name')
  }
  const name = requiredString(parsed.flags, 'name').trim()
  if (!name) {
    throw new RemoteLinearWriteArgumentError('invalid_argument', '--name must not be blank')
  }
  assertRemoteProjectTextCap(name, LINEAR_PROJECT_NAME_CAP, 'name')
  // Why: deduped like the local CLI and the edit path, so the same command sends the
  // same references over SSH and costs the host the same number of lookups.
  const teams = uniqueReferences(repeatedString(parsed.flags, 'team'))
  if (teams.length === 0) {
    throw new RemoteLinearWriteArgumentError('invalid_argument', 'Missing required --team')
  }
  // Why: references travel as user input; the host that owns the Linear token resolves them.
  return {
    name,
    teams,
    ...remoteProjectCreateText(parsed.flags, stdin),
    status: presentOptionalString(parsed.flags, 'status'),
    lead: presentOptionalString(parsed.flags, 'lead'),
    ...(parsed.flags.has('member')
      ? { members: uniqueReferences(repeatedString(parsed.flags, 'member')) }
      : {}),
    ...(parsed.flags.has('label')
      ? { labels: uniqueReferences(repeatedString(parsed.flags, 'label')) }
      : {}),
    ...remoteProjectCreateScalars(parsed.flags),
    writeId: optionalWriteIdV4(parsed.flags),
    workspaceId: optionalString(parsed.flags, 'workspace')
  }
}

/** Description and content are never trimmed: empty prose is a meaningful create value. */
/** Why: `--lead=` from an unset variable must fail, not create without a lead. */
function presentOptionalString(
  flags: Map<string, string | boolean>,
  name: string
): string | undefined {
  const value = optionalString(flags, name)
  if (flags.has(name) && value === undefined) {
    throw new RemoteLinearWriteArgumentError('invalid_argument', `--${name} needs a value`)
  }
  return value
}

function remoteProjectCreateText(
  flags: Map<string, string | boolean>,
  stdin: string | undefined
): { description?: string; content?: string } {
  const content = readRemoteBody(flags, false, stdin, { value: 'content', file: 'content-file' })
  const description = flags.has('description')
    ? requiredStringAllowingEmpty(flags, 'description')
    : undefined
  if (description !== undefined) {
    assertRemoteProjectTextCap(description, LINEAR_PROJECT_DESCRIPTION_CAP, 'description')
  }
  return {
    ...(description !== undefined ? { description } : {}),
    ...(content !== undefined ? { content } : {})
  }
}

/** Spread per flag so priority `none` (0) survives instead of being dropped as falsy. */
function remoteProjectCreateScalars(flags: Map<string, string | boolean>): {
  priority?: number
  startDate?: string
  targetDate?: string
  color?: string
} {
  return {
    ...(flags.has('priority') ? { priority: priorityFlag(flags, 'priority') } : {}),
    ...(flags.has('start-date') ? { startDate: calendarDateFlag(flags, 'start-date') } : {}),
    ...(flags.has('target-date') ? { targetDate: calendarDateFlag(flags, 'target-date') } : {}),
    ...(flags.has('color') ? { color: hexColorFlag(flags, 'color') } : {})
  }
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
      'Pass a Linear project UUID, slugId, URL, or exact name positionally or as --id'
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

function uniqueReferences(values: string[]): string[] {
  return [...new Set(values)]
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
      `--health must be one of ${LINEAR_PROJECT_UPDATE_HEALTH_CLI_VALUES.join(', ')}`
    )
  }
  return health
}

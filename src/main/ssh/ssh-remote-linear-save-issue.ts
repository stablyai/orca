import type { RpcResponse } from '../runtime/rpc/core'
import type { RpcDispatcher } from '../runtime/rpc/dispatcher'
import {
  RemoteLinearWriteArgumentError,
  buildRemoteContext,
  call,
  dueDateFlag,
  nonNegativeIntegerFlag,
  optionalString,
  optionalWriteId,
  priorityFlag,
  readRemoteBody,
  repeatedString,
  rejectAllWorkspaceForWrite,
  validateLinearRemoteArgs
} from './ssh-remote-linear-write-support'

type ParsedRemoteCli = {
  commandPath: string[]
  flags: Map<string, string | boolean>
}

const LINEAR_SAVE_ISSUE_FLAGS = new Set([
  'help',
  'json',
  'pairing-code',
  'environment',
  'workspace',
  'current',
  'id',
  'team',
  'title',
  'description',
  'body',
  'body-file',
  'state',
  'assignee',
  'priority',
  'estimate',
  'due-date',
  'label',
  'project',
  'parent-id',
  'write-id'
])

export async function dispatchRemoteLinearSaveIssue(
  dispatcher: RpcDispatcher,
  parsed: ParsedRemoteCli,
  env: Record<string, string>,
  stdin?: string
): Promise<RpcResponse> {
  validateLinearRemoteArgs(parsed, LINEAR_SAVE_ISSUE_FLAGS, ['linear', 'save-issue'], 1, 'id')
  rejectAllWorkspaceForWrite(parsed.flags)
  const body = readRemoteBody(parsed.flags, false, stdin)
  const description = optionalString(parsed.flags, 'description')
  if (body !== undefined && description !== undefined) {
    throw new RemoteLinearWriteArgumentError(
      'invalid_argument',
      'Use either --description or --body, not both'
    )
  }
  return await call(dispatcher, 'linear.saveIssue', {
    ...buildOptionalRemoteTargetRequest(parsed, env),
    team: optionalString(parsed.flags, 'team'),
    title: optionalString(parsed.flags, 'title'),
    description: description ?? body,
    state: optionalString(parsed.flags, 'state'),
    assignee: nullableString(parsed.flags, 'assignee'),
    priority: parsed.flags.has('priority') ? priorityFlag(parsed.flags, 'priority') : undefined,
    estimate: nullableNonNegativeInteger(parsed.flags, 'estimate'),
    dueDate: nullableDueDate(parsed.flags, 'due-date'),
    labels: parsed.flags.has('label') ? repeatedString(parsed.flags, 'label') : undefined,
    project: nullableString(parsed.flags, 'project'),
    parentId: nullableString(parsed.flags, 'parent-id'),
    writeId: optionalWriteId(parsed.flags)
  })
}

function buildOptionalRemoteTargetRequest(
  parsed: ParsedRemoteCli,
  env: Record<string, string>
): Record<string, unknown> {
  const input = optionalString(parsed.flags, 'id') ?? parsed.commandPath.slice(2).join(' ').trim()
  const current = parsed.flags.get('current') === true
  if (input && current) {
    throw new RemoteLinearWriteArgumentError(
      'invalid_argument',
      'Pass either <id> or --current, not both'
    )
  }
  return {
    input: input || undefined,
    current,
    workspaceId: optionalString(parsed.flags, 'workspace'),
    context: buildRemoteContext(env)
  }
}

function nullableString(
  flags: Map<string, string | boolean>,
  name: string
): string | null | undefined {
  const value = optionalString(flags, name)
  return value === 'null' ? null : value
}

function nullableNonNegativeInteger(
  flags: Map<string, string | boolean>,
  name: string
): number | null | undefined {
  const value = optionalString(flags, name)
  if (value === undefined) {
    return undefined
  }
  return value === 'null' ? null : nonNegativeIntegerFlag(flags, name)
}

function nullableDueDate(
  flags: Map<string, string | boolean>,
  name: string
): string | null | undefined {
  const value = optionalString(flags, name)
  if (value === undefined) {
    return undefined
  }
  return value === 'null' ? null : dueDateFlag(flags, name)
}

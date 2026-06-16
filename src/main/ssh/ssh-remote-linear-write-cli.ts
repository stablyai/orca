import type { RpcResponse } from '../runtime/rpc/core'
import type { RpcDispatcher } from '../runtime/rpc/dispatcher'
import { getRemoteLinearWriteHelp } from './ssh-remote-linear-write-help'
import {
  RemoteLinearWriteArgumentError,
  buildRemoteContext,
  buildRemoteTargetRequest,
  call,
  dueDateFlag,
  isRemoteCommand,
  nonNegativeIntegerFlag,
  optionalString,
  optionalWriteId,
  priorityFlag,
  readRemoteBody,
  repeatedString,
  rejectAllWorkspaceForWrite,
  requiredHttpUrl,
  requiredString,
  validateLinearRemoteArgs
} from './ssh-remote-linear-write-support'

type ParsedRemoteCli = {
  commandPath: string[]
  flags: Map<string, string | boolean>
}

export { getRemoteLinearWriteHelp }

const LINEAR_WRITE_FLAGS = new Set(['help', 'json', 'pairing-code', 'environment', 'workspace'])
const LINEAR_TARGET_WRITE_FLAGS = new Set([...LINEAR_WRITE_FLAGS, 'current', 'id'])
const LINEAR_STATUS_FLAGS = new Set([...LINEAR_TARGET_WRITE_FLAGS, 'to'])
const LINEAR_ASSIGNEE_SET_FLAGS = new Set([...LINEAR_TARGET_WRITE_FLAGS, 'me', 'to-id'])
const LINEAR_TASK_SET_FLAGS = new Set([...LINEAR_TARGET_WRITE_FLAGS, 'to'])
const LINEAR_TASK_CLEAR_FLAGS = LINEAR_TARGET_WRITE_FLAGS
const LINEAR_LABEL_FLAGS = new Set([...LINEAR_TARGET_WRITE_FLAGS, 'label'])
const LINEAR_COMMENT_FLAGS = new Set([
  ...LINEAR_TARGET_WRITE_FLAGS,
  'body',
  'body-file',
  'reply-to',
  'write-id'
])
const LINEAR_ATTACH_FLAGS = new Set([...LINEAR_TARGET_WRITE_FLAGS, 'url', 'title', 'write-id'])
const LINEAR_CREATE_FLAGS = new Set([
  ...LINEAR_WRITE_FLAGS,
  'title',
  'body',
  'body-file',
  'team',
  'state',
  'assignee',
  'priority',
  'estimate',
  'due-date',
  'label',
  'parent',
  'parent-current',
  'write-id'
])

export async function tryDispatchRemoteLinearWriteCli(
  dispatcher: RpcDispatcher,
  parsed: ParsedRemoteCli,
  env: Record<string, string>,
  stdin?: string
): Promise<RpcResponse | null> {
  if (isRemoteCommand(parsed, 'linear', 'status', 'set')) {
    validateLinearRemoteArgs(parsed, LINEAR_STATUS_FLAGS, ['linear', 'status', 'set'], 1, 'id')
    return await call(dispatcher, 'linear.issueSetState', {
      ...buildRemoteTargetRequest(parsed, env, 3),
      to: requiredString(parsed.flags, 'to')
    })
  }
  if (isRemoteCommand(parsed, 'linear', 'assignee', 'set')) {
    validateLinearRemoteArgs(
      parsed,
      LINEAR_ASSIGNEE_SET_FLAGS,
      ['linear', 'assignee', 'set'],
      1,
      'id'
    )
    const me = parsed.flags.get('me') === true
    const toId = optionalString(parsed.flags, 'to-id')
    if (me === Boolean(toId)) {
      throw new RemoteLinearWriteArgumentError(
        'invalid_argument',
        'Pass exactly one of --me or --to-id'
      )
    }
    return await call(dispatcher, 'linear.issueUpdateTask', {
      ...buildRemoteTargetRequest(parsed, env, 3),
      operation: 'assignee',
      ...(me ? { assigneeMe: true } : { assigneeId: toId })
    })
  }
  if (isRemoteCommand(parsed, 'linear', 'assignee', 'clear')) {
    validateLinearRemoteArgs(
      parsed,
      LINEAR_TASK_CLEAR_FLAGS,
      ['linear', 'assignee', 'clear'],
      1,
      'id'
    )
    return await call(dispatcher, 'linear.issueUpdateTask', {
      ...buildRemoteTargetRequest(parsed, env, 3),
      operation: 'assignee',
      assigneeId: null
    })
  }
  if (isRemoteCommand(parsed, 'linear', 'priority', 'set')) {
    validateLinearRemoteArgs(parsed, LINEAR_TASK_SET_FLAGS, ['linear', 'priority', 'set'], 1, 'id')
    return await call(dispatcher, 'linear.issueUpdateTask', {
      ...buildRemoteTargetRequest(parsed, env, 3),
      operation: 'priority',
      priority: priorityFlag(parsed.flags, 'to')
    })
  }
  if (isRemoteCommand(parsed, 'linear', 'priority', 'clear')) {
    validateLinearRemoteArgs(
      parsed,
      LINEAR_TASK_CLEAR_FLAGS,
      ['linear', 'priority', 'clear'],
      1,
      'id'
    )
    return await call(dispatcher, 'linear.issueUpdateTask', {
      ...buildRemoteTargetRequest(parsed, env, 3),
      operation: 'priority',
      priority: 0
    })
  }
  if (isRemoteCommand(parsed, 'linear', 'estimate', 'set')) {
    validateLinearRemoteArgs(parsed, LINEAR_TASK_SET_FLAGS, ['linear', 'estimate', 'set'], 1, 'id')
    return await call(dispatcher, 'linear.issueUpdateTask', {
      ...buildRemoteTargetRequest(parsed, env, 3),
      operation: 'estimate',
      estimate: nonNegativeIntegerFlag(parsed.flags, 'to')
    })
  }
  if (isRemoteCommand(parsed, 'linear', 'estimate', 'clear')) {
    validateLinearRemoteArgs(
      parsed,
      LINEAR_TASK_CLEAR_FLAGS,
      ['linear', 'estimate', 'clear'],
      1,
      'id'
    )
    return await call(dispatcher, 'linear.issueUpdateTask', {
      ...buildRemoteTargetRequest(parsed, env, 3),
      operation: 'estimate',
      estimate: null
    })
  }
  if (isRemoteCommand(parsed, 'linear', 'due-date', 'set')) {
    validateLinearRemoteArgs(parsed, LINEAR_TASK_SET_FLAGS, ['linear', 'due-date', 'set'], 1, 'id')
    return await call(dispatcher, 'linear.issueUpdateTask', {
      ...buildRemoteTargetRequest(parsed, env, 3),
      operation: 'dueDate',
      dueDate: dueDateFlag(parsed.flags, 'to')
    })
  }
  if (isRemoteCommand(parsed, 'linear', 'due-date', 'clear')) {
    validateLinearRemoteArgs(
      parsed,
      LINEAR_TASK_CLEAR_FLAGS,
      ['linear', 'due-date', 'clear'],
      1,
      'id'
    )
    return await call(dispatcher, 'linear.issueUpdateTask', {
      ...buildRemoteTargetRequest(parsed, env, 3),
      operation: 'dueDate',
      dueDate: null
    })
  }
  for (const mode of ['add', 'remove', 'set'] as const) {
    if (isRemoteCommand(parsed, 'linear', 'label', mode)) {
      validateLinearRemoteArgs(parsed, LINEAR_LABEL_FLAGS, ['linear', 'label', mode], 1, 'id')
      const labels = repeatedString(parsed.flags, 'label')
      if (labels.length === 0) {
        throw new RemoteLinearWriteArgumentError('invalid_argument', 'Missing required --label')
      }
      return await call(dispatcher, 'linear.issueUpdateTask', {
        ...buildRemoteTargetRequest(parsed, env, 3),
        operation: 'labels',
        labelMode: mode,
        labels
      })
    }
  }
  if (isRemoteCommand(parsed, 'linear', 'comment', 'add')) {
    validateLinearRemoteArgs(parsed, LINEAR_COMMENT_FLAGS, ['linear', 'comment', 'add'], 1, 'id')
    return await call(dispatcher, 'linear.issueAddComment', {
      ...buildRemoteTargetRequest(parsed, env, 3),
      body: readRemoteBody(parsed.flags, true, stdin),
      replyTo: optionalString(parsed.flags, 'reply-to'),
      writeId: optionalWriteId(parsed.flags)
    })
  }
  if (isRemoteCommand(parsed, 'linear', 'attach')) {
    validateLinearRemoteArgs(parsed, LINEAR_ATTACH_FLAGS, ['linear', 'attach'], 1, 'id')
    return await call(dispatcher, 'linear.issueAttachLink', {
      ...buildRemoteTargetRequest(parsed, env, 2),
      url: requiredHttpUrl(parsed.flags, 'url'),
      title: optionalString(parsed.flags, 'title'),
      writeId: optionalWriteId(parsed.flags)
    })
  }
  if (isRemoteCommand(parsed, 'linear', 'create')) {
    validateLinearRemoteArgs(parsed, LINEAR_CREATE_FLAGS, ['linear', 'create'], 0, 'id')
    rejectAllWorkspaceForWrite(parsed.flags)
    const parentInput = optionalString(parsed.flags, 'parent')
    const parentCurrent = parsed.flags.get('parent-current') === true
    if (parentInput && parentCurrent) {
      throw new RemoteLinearWriteArgumentError(
        'invalid_argument',
        'Use either --parent or --parent-current, not both'
      )
    }
    const body = readRemoteBody(parsed.flags, false, stdin)
    return await call(dispatcher, 'linear.issueCreate', {
      title: requiredString(parsed.flags, 'title'),
      ...(body !== undefined ? { body } : {}),
      teamInput: optionalString(parsed.flags, 'team'),
      state: optionalString(parsed.flags, 'state'),
      assignee: optionalString(parsed.flags, 'assignee'),
      priority: parsed.flags.has('priority') ? priorityFlag(parsed.flags, 'priority') : undefined,
      estimate: parsed.flags.has('estimate')
        ? nonNegativeIntegerFlag(parsed.flags, 'estimate')
        : undefined,
      dueDate: parsed.flags.has('due-date') ? dueDateFlag(parsed.flags, 'due-date') : undefined,
      labels: repeatedString(parsed.flags, 'label'),
      parentInput,
      parentCurrent,
      workspaceId: optionalString(parsed.flags, 'workspace'),
      writeId: optionalWriteId(parsed.flags),
      context: buildRemoteContext(env)
    })
  }
  return null
}

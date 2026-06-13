import type { RpcResponse } from '../runtime/rpc/core'
import type { RpcDispatcher } from '../runtime/rpc/dispatcher'

type ParsedRemoteCli = {
  commandPath: string[]
  flags: Map<string, string | boolean>
}

class RemoteLinearWriteArgumentError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'RemoteLinearWriteArgumentError'
    this.code = code
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const LINEAR_WRITE_FLAGS = new Set(['help', 'json', 'pairing-code', 'environment', 'workspace'])
const LINEAR_TARGET_WRITE_FLAGS = new Set([...LINEAR_WRITE_FLAGS, 'current', 'id'])
const LINEAR_STATUS_FLAGS = new Set([...LINEAR_TARGET_WRITE_FLAGS, 'to'])
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
  'parent',
  'parent-current',
  'write-id'
])

export function getRemoteLinearWriteHelp(parsed: ParsedRemoteCli): string | null {
  const path = parsed.commandPath
  if (matchesRemoteCommand(path, 'linear', 'status', 'set')) {
    return LINEAR_STATUS_HELP
  }
  if (matchesRemoteCommand(path, 'linear', 'comment', 'add')) {
    return LINEAR_COMMENT_HELP
  }
  if (matchesRemoteCommand(path, 'linear', 'attach')) {
    return LINEAR_ATTACH_HELP
  }
  if (matchesRemoteCommand(path, 'linear', 'create')) {
    return LINEAR_CREATE_HELP
  }
  return null
}

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
      teamKey: optionalString(parsed.flags, 'team'),
      parentInput,
      parentCurrent,
      workspaceId: optionalString(parsed.flags, 'workspace'),
      writeId: optionalWriteId(parsed.flags),
      context: buildRemoteContext(env)
    })
  }
  return null
}

function buildRemoteTargetRequest(
  parsed: ParsedRemoteCli,
  env: Record<string, string>,
  positionalStart: number
): Record<string, unknown> {
  rejectAllWorkspaceForWrite(parsed.flags)
  const input = optionalString(parsed.flags, 'id') ?? remotePositional(parsed, positionalStart)
  const current = parsed.flags.get('current') === true
  if (input && current) {
    throw new RemoteLinearWriteArgumentError(
      'invalid_argument',
      'Pass either <id> or --current, not both'
    )
  }
  if (!input && !current) {
    throw new RemoteLinearWriteArgumentError(
      'linear_issue_required',
      'Pass a Linear issue id or --current'
    )
  }
  return {
    input,
    current,
    workspaceId: optionalString(parsed.flags, 'workspace'),
    context: buildRemoteContext(env)
  }
}

function buildRemoteContext(env: Record<string, string>): Record<string, unknown> {
  return {
    remote: true,
    ...(env.ORCA_WORKTREE_ID ? { worktreeId: env.ORCA_WORKTREE_ID } : {}),
    ...(env.ORCA_TERMINAL_HANDLE ? { terminalHandle: env.ORCA_TERMINAL_HANDLE } : {})
  }
}

function readRemoteBody(
  flags: Map<string, string | boolean>,
  required: boolean,
  stdin?: string
): string | undefined {
  const hasBody = flags.has('body')
  const hasBodyFile = flags.has('body-file')
  if (hasBody && hasBodyFile) {
    throw new RemoteLinearWriteArgumentError(
      'invalid_argument',
      'Use either --body or --body-file, not both'
    )
  }
  if (hasBodyFile) {
    const path = requiredString(flags, 'body-file')
    if (path !== '-') {
      throw new RemoteLinearWriteArgumentError(
        'invalid_argument',
        'SSH Linear writes only support --body-file - for stdin.'
      )
    }
    if (stdin === undefined) {
      throw new RemoteLinearWriteArgumentError(
        'invalid_argument',
        'SSH Linear writes require stdin when using --body-file -.'
      )
    }
    return stdin
  }
  if (!hasBody) {
    if (required) {
      throw new RemoteLinearWriteArgumentError('invalid_argument', 'Missing --body or --body-file')
    }
    return undefined
  }
  return requiredStringAllowingEmpty(flags, 'body')
}

function rejectAllWorkspaceForWrite(flags: Map<string, string | boolean>): void {
  if (optionalString(flags, 'workspace') === 'all') {
    throw new RemoteLinearWriteArgumentError(
      'linear_invalid_workspace',
      '--workspace all is not valid for Linear writes'
    )
  }
}

function optionalWriteId(flags: Map<string, string | boolean>): string | undefined {
  if (!flags.has('write-id')) {
    return undefined
  }
  const writeId = requiredString(flags, 'write-id')
  if (!UUID_PATTERN.test(writeId)) {
    throw new RemoteLinearWriteArgumentError('linear_invalid_write_id', '--write-id must be a UUID')
  }
  return writeId
}

function requiredHttpUrl(flags: Map<string, string | boolean>, name: string): string {
  const value = requiredString(flags, name)
  try {
    const parsed = new URL(value)
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return value
    }
  } catch {
    // Fall through to stable Linear validation error.
  }
  throw new RemoteLinearWriteArgumentError(
    'linear_invalid_url',
    '--url must be an absolute http(s) URL'
  )
}

function validateLinearRemoteArgs(
  parsed: ParsedRemoteCli,
  allowedFlags: ReadonlySet<string>,
  command: string[],
  maxPositionals: number,
  positionalFlag: string
): void {
  for (const flag of parsed.flags.keys()) {
    if (!allowedFlags.has(flag)) {
      throw new RemoteLinearWriteArgumentError(
        'invalid_argument',
        `Unknown flag --${flag} for command: ${command.join(' ')}`
      )
    }
  }
  const positionals = parsed.commandPath.slice(command.length)
  if (positionals.length > maxPositionals) {
    throw new RemoteLinearWriteArgumentError(
      'invalid_argument',
      `Unknown command: ${parsed.commandPath.join(' ')}`
    )
  }
  if (positionals.length > 0 && parsed.flags.has(positionalFlag)) {
    throw new RemoteLinearWriteArgumentError(
      'invalid_argument',
      `Pass --${positionalFlag} either positionally or as a flag, not both.`
    )
  }
}

function isRemoteCommand(parsed: ParsedRemoteCli, ...command: string[]): boolean {
  return command.every((part, index) => parsed.commandPath[index] === part)
}

function matchesRemoteCommand(commandPath: string[], ...command: string[]): boolean {
  return (
    commandPath.length === command.length &&
    command.every((part, index) => commandPath[index] === part)
  )
}

function remotePositional(parsed: ParsedRemoteCli, startIndex: number): string | undefined {
  const value = parsed.commandPath.slice(startIndex).join(' ').trim()
  return value || undefined
}

function requiredString(flags: Map<string, string | boolean>, name: string): string {
  const value = optionalString(flags, name)
  if (!value) {
    throw new RemoteLinearWriteArgumentError('invalid_argument', `Missing --${name}`)
  }
  return value
}

function requiredStringAllowingEmpty(flags: Map<string, string | boolean>, name: string): string {
  const value = flags.get(name)
  if (typeof value === 'string') {
    return value
  }
  throw new RemoteLinearWriteArgumentError('invalid_argument', `Missing --${name}`)
}

function optionalString(flags: Map<string, string | boolean>, name: string): string | undefined {
  const value = flags.get(name)
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

async function call(
  dispatcher: RpcDispatcher,
  method: string,
  params?: Record<string, unknown>
): Promise<RpcResponse> {
  return await dispatcher.dispatch({
    id: `remote-cli-${Date.now()}`,
    authToken: 'remote-cli',
    method,
    params
  })
}

const LINEAR_STATUS_HELP = `orca linear status set\n\nUsage: orca linear status set [<id>] [--current] --to <state> [--workspace <id>] [--json]\n\nSet a Linear issue status`
const LINEAR_COMMENT_HELP = `orca linear comment add\n\nUsage: orca linear comment add [<id>] [--current] (--body <text> | --body-file <path|->) [--reply-to <commentId>] [--write-id <uuid>] [--workspace <id>] [--json]\n\nAdd a comment to a Linear issue`
const LINEAR_ATTACH_HELP = `orca linear attach\n\nUsage: orca linear attach [<id>] [--current] --url <url> [--title <title>] [--write-id <uuid>] [--workspace <id>] [--json]\n\nAttach a link to a Linear issue`
const LINEAR_CREATE_HELP = `orca linear create\n\nUsage: orca linear create --title <title> [--body <text> | --body-file <path|->] [--team <key>] [--parent <id> | --parent-current] [--write-id <uuid>] [--workspace <id>] [--json]\n\nCreate a Linear issue`

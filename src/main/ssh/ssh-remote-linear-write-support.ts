import type { RpcResponse } from '../runtime/rpc/core'
import type { RpcDispatcher } from '../runtime/rpc/dispatcher'

type ParsedRemoteCli = {
  commandPath: string[]
  flags: Map<string, string | boolean>
}

export class RemoteLinearWriteArgumentError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'RemoteLinearWriteArgumentError'
    this.code = code
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const REPEATED_FLAG_SEPARATOR = '\u0000'
const LINEAR_PRIORITY_VALUES = new Map([
  ['none', 0],
  ['urgent', 1],
  ['high', 2],
  ['medium', 3],
  ['low', 4]
])

export function buildRemoteTargetRequest(
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

export function buildRemoteContext(env: Record<string, string>): Record<string, unknown> {
  return {
    remote: true,
    ...(env.ORCA_WORKTREE_ID ? { worktreeId: env.ORCA_WORKTREE_ID } : {}),
    ...(env.ORCA_TERMINAL_HANDLE ? { terminalHandle: env.ORCA_TERMINAL_HANDLE } : {})
  }
}

export function readRemoteBody(
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

export function rejectAllWorkspaceForWrite(flags: Map<string, string | boolean>): void {
  if (optionalString(flags, 'workspace') === 'all') {
    throw new RemoteLinearWriteArgumentError(
      'linear_invalid_workspace',
      '--workspace all is not valid for Linear writes'
    )
  }
}

export function optionalWriteId(flags: Map<string, string | boolean>): string | undefined {
  if (!flags.has('write-id')) {
    return undefined
  }
  const writeId = requiredString(flags, 'write-id')
  if (!UUID_PATTERN.test(writeId)) {
    throw new RemoteLinearWriteArgumentError('linear_invalid_write_id', '--write-id must be a UUID')
  }
  return writeId
}

export function priorityFlag(flags: Map<string, string | boolean>, name: string): number {
  const value = requiredString(flags, name).toLocaleLowerCase()
  const priority = LINEAR_PRIORITY_VALUES.get(value)
  if (priority === undefined) {
    throw new RemoteLinearWriteArgumentError(
      'invalid_argument',
      `--${name} must be none, low, medium, high, or urgent`
    )
  }
  return priority
}

export function nonNegativeIntegerFlag(flags: Map<string, string | boolean>, name: string): number {
  const value = Number(requiredString(flags, name))
  if (!Number.isInteger(value) || value < 0) {
    throw new RemoteLinearWriteArgumentError(
      'invalid_argument',
      `--${name} must be a non-negative integer`
    )
  }
  return value
}

export function dueDateFlag(flags: Map<string, string | boolean>, name: string): string {
  const value = requiredString(flags, name)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new RemoteLinearWriteArgumentError('invalid_argument', `--${name} must use YYYY-MM-DD`)
  }
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new RemoteLinearWriteArgumentError(
      'invalid_argument',
      `--${name} must be a real calendar date`
    )
  }
  return value
}

export function repeatedString(flags: Map<string, string | boolean>, name: string): string[] {
  const value = optionalString(flags, name)
  return value ? value.split(REPEATED_FLAG_SEPARATOR).filter(Boolean) : []
}

export function requiredHttpUrl(flags: Map<string, string | boolean>, name: string): string {
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

export function validateLinearRemoteArgs(
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

export function isRemoteCommand(parsed: ParsedRemoteCli, ...command: string[]): boolean {
  return command.every((part, index) => parsed.commandPath[index] === part)
}

export function remotePositional(parsed: ParsedRemoteCli, startIndex: number): string | undefined {
  const value = parsed.commandPath.slice(startIndex).join(' ').trim()
  return value || undefined
}

export function requiredString(flags: Map<string, string | boolean>, name: string): string {
  const value = optionalString(flags, name)
  if (!value) {
    throw new RemoteLinearWriteArgumentError('invalid_argument', `Missing --${name}`)
  }
  return value
}

export function requiredStringAllowingEmpty(
  flags: Map<string, string | boolean>,
  name: string
): string {
  const value = flags.get(name)
  if (typeof value === 'string') {
    return value
  }
  throw new RemoteLinearWriteArgumentError('invalid_argument', `Missing --${name}`)
}

export function optionalString(
  flags: Map<string, string | boolean>,
  name: string
): string | undefined {
  const value = flags.get(name)
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export async function call(
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

import {
  LINEAR_CHILDREN_MAX_DEPTH,
  clampLinearIssueDepth,
  clampLinearSearchLimit,
  type LinearIssueInclude
} from '../../shared/linear-agent-access'
import type { RpcDispatcher } from '../runtime/rpc/dispatcher'
import type { RpcResponse } from '../runtime/rpc/core'

type ParsedRemoteCli = {
  commandPath: string[]
  flags: Map<string, string | boolean>
}

export class RemoteCliArgumentError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'RemoteCliArgumentError'
    this.code = code
  }
}

export function getRemoteLinearHelp(parsed: ParsedRemoteCli): string | null {
  const helpPath = remoteLinearHelpPath(parsed)
  if (!helpPath) {
    return null
  }
  if (helpPath.length === 1 && helpPath[0] === 'linear') {
    return LINEAR_HELP
  }
  if (matchesRemoteCommand(helpPath, 'linear', 'issue')) {
    return LINEAR_ISSUE_HELP
  }
  if (matchesRemoteCommand(helpPath, 'linear', 'search')) {
    return LINEAR_SEARCH_HELP
  }
  return null
}

function remoteLinearHelpPath(parsed: ParsedRemoteCli): string[] | null {
  if (parsed.commandPath[0] === 'help' && parsed.commandPath[1] === 'linear') {
    return parsed.commandPath.slice(1)
  }
  if (parsed.flags.has('help') && parsed.commandPath[0] === 'linear') {
    return parsed.commandPath
  }
  return null
}

const LINEAR_HELP = `orca linear

Usage: orca linear <command> [options]

Commands:
  issue              Read Linear issue context for agents
  search             Search connected Linear workspaces

Run \`orca linear <command> --help\` for command-specific usage.`

const LINEAR_ISSUE_HELP = `orca linear issue

Usage: orca linear issue [<id>] [--current] [--comments] [--children] [--depth <n>] [--attachments] [--relations] [--full] [--workspace <id>] [--json]

Read Linear issue context for agents

Options:
  --help                 Show this help message
  --json                 Emit machine-readable JSON
  --pairing-code
  --environment
  --current              Use the current Orca worktree linked Linear issue
  --comments             Include threaded Linear comments
  --children             Include recursive child issues
  --depth <n>            Child issue depth for --children/--full
  --attachments          Include attachment metadata and URLs
  --relations            Include blocking, related, and duplicate links
  --full                 Include all supported V1 issue context within caps
  --workspace <id>      Connected Linear workspace id
  --id <id>             Linear issue key, id, or URL

Examples:
  $ orca linear issue ENG-123
  $ orca linear issue --current --comments
  $ orca linear issue https://linear.app/acme/issue/ENG-123 --full --json`

const LINEAR_SEARCH_HELP = `orca linear search

Usage: orca linear search <query> [--limit <n>] [--workspace <id>|all] [--json]

Search connected Linear workspaces

Options:
  --help                 Show this help message
  --json                 Emit machine-readable JSON
  --pairing-code
  --environment
  --limit <n>            Maximum number of rows to return
  --workspace <id|all>  Connected Linear workspace id, or all
  --query <text>        Text to search across Linear issues

Examples:
  $ orca linear search "auth bug"
  $ orca linear search ENG --workspace all --json`

const LINEAR_ISSUE_FLAGS = new Set([
  'help',
  'json',
  'pairing-code',
  'environment',
  'current',
  'comments',
  'children',
  'depth',
  'attachments',
  'relations',
  'full',
  'workspace',
  'id'
])
const LINEAR_SEARCH_FLAGS = new Set([
  'help',
  'json',
  'pairing-code',
  'environment',
  'limit',
  'workspace',
  'query'
])

export async function tryDispatchRemoteLinearCli(
  dispatcher: RpcDispatcher,
  parsed: ParsedRemoteCli,
  env: Record<string, string>
): Promise<RpcResponse | null> {
  if (isRemoteCommand(parsed, 'linear', 'issue')) {
    validateLinearRemoteArgs(parsed, {
      command: ['linear', 'issue'],
      allowedFlags: LINEAR_ISSUE_FLAGS,
      positionalFlag: 'id',
      maxPositionals: 1
    })
    return await call(dispatcher, 'linear.issueContext', buildRemoteLinearIssueRequest(parsed, env))
  }
  if (isRemoteCommand(parsed, 'linear', 'search')) {
    validateLinearRemoteArgs(parsed, {
      command: ['linear', 'search'],
      allowedFlags: LINEAR_SEARCH_FLAGS,
      positionalFlag: 'query',
      maxPositionals: 1
    })
    return await call(dispatcher, 'linear.agentSearchIssues', {
      query: remotePositional(parsed, 2) ?? requiredString(parsed.flags, 'query'),
      limit: clampLinearSearchLimit(optionalPositiveInteger(parsed.flags, 'limit')),
      workspaceId: optionalString(parsed.flags, 'workspace')
    })
  }
  return null
}

function validateLinearRemoteArgs(
  parsed: ParsedRemoteCli,
  options: {
    command: string[]
    allowedFlags: ReadonlySet<string>
    positionalFlag: string
    maxPositionals: number
  }
): void {
  for (const flag of parsed.flags.keys()) {
    if (!options.allowedFlags.has(flag)) {
      throw new RemoteCliArgumentError(
        'invalid_argument',
        `Unknown flag --${flag} for command: ${options.command.join(' ')}`
      )
    }
  }

  const positionals = parsed.commandPath.slice(options.command.length)
  if (positionals.length > options.maxPositionals) {
    throw new RemoteCliArgumentError(
      'invalid_argument',
      `Unknown command: ${parsed.commandPath.join(' ')}`
    )
  }
  if (positionals.length > 0 && parsed.flags.has(options.positionalFlag)) {
    throw new RemoteCliArgumentError(
      'invalid_argument',
      `Pass --${options.positionalFlag} either positionally or as a flag, not both.`
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

function buildRemoteLinearIssueRequest(
  parsed: ParsedRemoteCli,
  env: Record<string, string>
): Record<string, unknown> {
  const full = parsed.flags.get('full') === true
  const include: Record<LinearIssueInclude, boolean> = {
    comments: full || parsed.flags.get('comments') === true,
    children: full || parsed.flags.get('children') === true,
    attachments: full || parsed.flags.get('attachments') === true,
    relations: full || parsed.flags.get('relations') === true
  }
  if (parsed.flags.has('depth') && !include.children) {
    throw new RemoteCliArgumentError('invalid_argument', '--depth requires --children or --full')
  }
  const requestedDepth = optionalNonNegativeInteger(parsed.flags, 'depth')
  if (requestedDepth !== undefined && requestedDepth > LINEAR_CHILDREN_MAX_DEPTH) {
    throw new RemoteCliArgumentError(
      'invalid_argument',
      `--depth must be at most ${LINEAR_CHILDREN_MAX_DEPTH}`
    )
  }
  const workspaceId = optionalString(parsed.flags, 'workspace')
  if (workspaceId === 'all') {
    throw new RemoteCliArgumentError(
      'linear_invalid_workspace',
      '--workspace all is not valid for issue'
    )
  }
  const input = optionalString(parsed.flags, 'id') ?? remotePositional(parsed, 2)
  return {
    input,
    current: input ? false : parsed.flags.get('current') === true,
    workspaceId,
    include,
    depth: clampLinearIssueDepth(requestedDepth),
    context: {
      remote: true,
      ...(env.ORCA_WORKTREE_ID ? { worktreeId: env.ORCA_WORKTREE_ID } : {}),
      ...(env.ORCA_TERMINAL_HANDLE ? { terminalHandle: env.ORCA_TERMINAL_HANDLE } : {})
    }
  }
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

function requiredString(flags: Map<string, string | boolean>, name: string): string {
  const value = optionalString(flags, name)
  if (!value) {
    throw new RemoteCliArgumentError('invalid_argument', `Missing --${name}`)
  }
  return value
}

function optionalString(flags: Map<string, string | boolean>, name: string): string | undefined {
  const value = flags.get(name)
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function optionalNumber(flags: Map<string, string | boolean>, name: string): number | undefined {
  const value = optionalString(flags, name)
  if (value === undefined) {
    return undefined
  }
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    throw new RemoteCliArgumentError('invalid_argument', `Invalid numeric value for --${name}`)
  }
  return parsed
}

function optionalPositiveInteger(
  flags: Map<string, string | boolean>,
  name: string
): number | undefined {
  const value = optionalNumber(flags, name)
  if (value === undefined) {
    return undefined
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new RemoteCliArgumentError('invalid_argument', `Invalid positive integer for --${name}`)
  }
  return value
}

function optionalNonNegativeInteger(
  flags: Map<string, string | boolean>,
  name: string
): number | undefined {
  const value = optionalNumber(flags, name)
  if (value === undefined) {
    return undefined
  }
  if (!Number.isInteger(value) || value < 0) {
    throw new RemoteCliArgumentError(
      'invalid_argument',
      `Invalid non-negative integer for --${name}`
    )
  }
  return value
}

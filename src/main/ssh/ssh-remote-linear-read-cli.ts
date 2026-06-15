import {
  LINEAR_CHILDREN_MAX_DEPTH,
  clampLinearIssueDepth,
  clampLinearSearchLimit,
  type LinearIssueInclude
} from '../../shared/linear-agent-access'
import type { RpcDispatcher } from '../runtime/rpc/dispatcher'
import type { RpcResponse } from '../runtime/rpc/core'
import { RemoteCliArgumentError, type ParsedRemoteCli } from './ssh-remote-linear-argument-error'

import {
  LINEAR_ISSUE_FLAGS,
  LINEAR_LIST_FLAGS,
  LINEAR_SEARCH_FLAGS,
  LINEAR_TEAM_LIST_FLAGS,
  LINEAR_TEAM_LOOKUP_FLAGS
} from './ssh-remote-linear-read-flags'

export async function tryDispatchRemoteLinearReadCli(
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
  if (isRemoteCommand(parsed, 'linear', 'team', 'list')) {
    validateLinearRemoteArgs(parsed, {
      command: ['linear', 'team', 'list'],
      allowedFlags: LINEAR_TEAM_LIST_FLAGS,
      positionalFlag: 'id',
      maxPositionals: 0
    })
    return await call(dispatcher, 'linear.agentTeamList', {
      workspaceId: optionalString(parsed.flags, 'workspace')
    })
  }
  if (isRemoteCommand(parsed, 'linear', 'team', 'members')) {
    return await dispatchRemoteLinearTeamLookup(
      dispatcher,
      parsed,
      ['linear', 'team', 'members'],
      'linear.agentTeamMembers'
    )
  }
  if (isRemoteCommand(parsed, 'linear', 'team', 'states')) {
    return await dispatchRemoteLinearTeamLookup(
      dispatcher,
      parsed,
      ['linear', 'team', 'states'],
      'linear.agentTeamStates'
    )
  }
  if (isRemoteCommand(parsed, 'linear', 'team', 'labels')) {
    return await dispatchRemoteLinearTeamLookup(
      dispatcher,
      parsed,
      ['linear', 'team', 'labels'],
      'linear.agentTeamLabels'
    )
  }
  if (isRemoteCommand(parsed, 'linear', 'list')) {
    validateLinearRemoteArgs(parsed, {
      command: ['linear', 'list'],
      allowedFlags: LINEAR_LIST_FLAGS,
      positionalFlag: 'id',
      maxPositionals: 0
    })
    return await call(dispatcher, 'linear.agentIssueList', {
      filter: linearListFilter(parsed.flags),
      teamInput: optionalString(parsed.flags, 'team'),
      limit: optionalPositiveInteger(parsed.flags, 'limit'),
      workspaceId: optionalString(parsed.flags, 'workspace')
    })
  }
  return null
}

async function dispatchRemoteLinearTeamLookup(
  dispatcher: RpcDispatcher,
  parsed: ParsedRemoteCli,
  command: string[],
  method: string
): Promise<RpcResponse> {
  validateLinearRemoteArgs(parsed, {
    command,
    allowedFlags: LINEAR_TEAM_LOOKUP_FLAGS,
    positionalFlag: 'team',
    maxPositionals: 0
  })
  return await call(dispatcher, method, {
    teamInput: requiredString(parsed.flags, 'team'),
    workspaceId: optionalString(parsed.flags, 'workspace')
  })
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

function linearListFilter(
  flags: Map<string, string | boolean>
): 'assigned' | 'created' | 'all' | 'completed' | 'open' | undefined {
  const filter = optionalString(flags, 'filter')
  if (filter === undefined) {
    return undefined
  }
  if (['assigned', 'created', 'all', 'completed', 'open'].includes(filter)) {
    return filter as 'assigned' | 'created' | 'all' | 'completed' | 'open'
  }
  throw new RemoteCliArgumentError(
    'invalid_argument',
    '--filter must be assigned, created, all, completed, or open'
  )
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

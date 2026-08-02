import type { LinearMcpIssueListRequest } from '../../shared/linear-agent-access'
import type { RpcDispatcher } from '../runtime/rpc/dispatcher'
import type { RpcResponse } from '../runtime/rpc/core'
import { RemoteCliArgumentError, type ParsedRemoteCli } from './ssh-remote-cli-argument-error'
import { LINEAR_MCP_ISSUE_LIST_FLAGS } from './ssh-remote-linear-read-flags'

export async function dispatchRemoteLinearListIssues(
  dispatcher: RpcDispatcher,
  parsed: ParsedRemoteCli
): Promise<RpcResponse> {
  for (const flag of parsed.flags.keys()) {
    if (!LINEAR_MCP_ISSUE_LIST_FLAGS.has(flag)) {
      throw new RemoteCliArgumentError('invalid_argument', `Unknown flag: --${flag}`)
    }
  }
  if (parsed.commandPath.length !== 2) {
    throw new RemoteCliArgumentError('invalid_argument', 'list-issues does not accept positionals')
  }
  const priority = optionalInteger(parsed.flags, 'priority')
  if (priority !== undefined && (priority < 0 || priority > 4)) {
    throw new RemoteCliArgumentError('invalid_argument', '--priority must be between 0 and 4')
  }
  const limit = optionalPositiveInteger(parsed.flags, 'limit')
  const request: LinearMcpIssueListRequest = {
    team: optionalString(parsed.flags, 'team'),
    cycle: optionalString(parsed.flags, 'cycle'),
    label: optionalString(parsed.flags, 'label'),
    limit,
    query: optionalString(parsed.flags, 'query'),
    state: optionalString(parsed.flags, 'state'),
    cursor: optionalString(parsed.flags, 'cursor'),
    orderBy: orderBy(parsed.flags),
    project: optionalString(parsed.flags, 'project'),
    release: optionalString(parsed.flags, 'release'),
    assignee: optionalString(parsed.flags, 'assignee'),
    delegate: optionalString(parsed.flags, 'delegate'),
    parentId: optionalString(parsed.flags, 'parent-id'),
    priority,
    createdAt: optionalString(parsed.flags, 'created-at'),
    updatedAt: optionalString(parsed.flags, 'updated-at'),
    includeArchived: parsed.flags.get('include-archived') === true,
    workspaceId: optionalString(parsed.flags, 'workspace')
  }
  return await dispatcher.dispatch({
    id: `remote-cli-${Date.now()}`,
    authToken: 'remote-cli',
    method: 'linear.mcpListIssues',
    params: request
  })
}

function optionalString(flags: Map<string, string | boolean>, name: string): string | undefined {
  const value = flags.get(name)
  return typeof value === 'string' && value ? value : undefined
}

function optionalInteger(flags: Map<string, string | boolean>, name: string): number | undefined {
  const raw = optionalString(flags, name)
  if (raw === undefined) {
    return undefined
  }
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0) {
    throw new RemoteCliArgumentError('invalid_argument', `--${name} must be an integer`)
  }
  return value
}

function optionalPositiveInteger(
  flags: Map<string, string | boolean>,
  name: string
): number | undefined {
  const raw = optionalString(flags, name)
  if (raw === undefined) {
    return undefined
  }
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) {
    throw new RemoteCliArgumentError('invalid_argument', `Invalid positive integer for --${name}`)
  }
  return value
}

function orderBy(flags: Map<string, string | boolean>): LinearMcpIssueListRequest['orderBy'] {
  const value = optionalString(flags, 'order-by')
  if (value === undefined || value === 'createdAt' || value === 'updatedAt') {
    return value
  }
  throw new RemoteCliArgumentError('invalid_argument', '--order-by must be createdAt or updatedAt')
}

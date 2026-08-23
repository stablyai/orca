import type {
  LinearMcpIssueListRequest,
  LinearMcpIssueListResult
} from '../../shared/linear/agent-access'
import { LINEAR_MANUAL_ISSUE_ORDER_RUNTIME_CAPABILITY } from '../../shared/protocol-version'
import type { RuntimeStatus } from '../../shared/runtime-types'
import type { CommandHandler } from '../dispatch'
import {
  getOptionalNonNegativeIntegerFlag,
  getOptionalPositiveIntegerFlag,
  getOptionalStringFlag
} from '../flags'
import { printResult } from '../format'
import { formatLinearMcpIssueList, printLinearMcpIssueListWarnings } from '../linear-format'
import { RuntimeClientError } from '../runtime-client'

export const runLinearListIssues: CommandHandler = async ({ flags, client, json }) => {
  const priority = getOptionalNonNegativeIntegerFlag(flags, 'priority')
  if (priority !== undefined && priority > 4) {
    throw new RuntimeClientError('invalid_argument', '--priority must be between 0 and 4')
  }
  const cursor = getOptionalStringFlag(flags, 'cursor')
  const orderBy = getOrderBy(flags)
  if (orderBy === 'sortOrder' && cursor) {
    throw new RuntimeClientError(
      'invalid_argument',
      '--cursor cannot be used with --order-by sortOrder'
    )
  }
  if (orderBy === 'sortOrder') {
    await assertManualOrderSupported(client)
  }
  const request: LinearMcpIssueListRequest = {
    team: getOptionalStringFlag(flags, 'team'),
    cycle: getOptionalStringFlag(flags, 'cycle'),
    label: getOptionalStringFlag(flags, 'label'),
    limit: getOptionalPositiveIntegerFlag(flags, 'limit'),
    query: getOptionalStringFlag(flags, 'query'),
    state: getOptionalStringFlag(flags, 'state'),
    cursor,
    orderBy,
    project: getOptionalStringFlag(flags, 'project'),
    release: getOptionalStringFlag(flags, 'release'),
    assignee: getOptionalStringFlag(flags, 'assignee'),
    delegate: getOptionalStringFlag(flags, 'delegate'),
    parentId: getOptionalStringFlag(flags, 'parent-id'),
    priority,
    createdAt: getOptionalStringFlag(flags, 'created-at'),
    updatedAt: getOptionalStringFlag(flags, 'updated-at'),
    includeArchived: flags.get('include-archived') === true,
    workspaceId: getOptionalStringFlag(flags, 'workspace')
  }
  const response = await client.call<LinearMcpIssueListResult>('linear.mcpListIssues', request)
  if (!json) {
    printLinearMcpIssueListWarnings(response.result)
  }
  printResult(response, json, formatLinearMcpIssueList)
}

async function assertManualOrderSupported(
  client: Parameters<CommandHandler>[0]['client']
): Promise<void> {
  const status = await client.call<RuntimeStatus>('status.get')
  if (!status.result.capabilities?.includes(LINEAR_MANUAL_ISSUE_ORDER_RUNTIME_CAPABILITY)) {
    throw new RuntimeClientError(
      'incompatible_runtime',
      'The running Orca runtime is too old for Linear manual issue ordering. Update or restart Orca and try again.'
    )
  }
}

function getOrderBy(flags: Map<string, string | boolean>): LinearMcpIssueListRequest['orderBy'] {
  const value = getOptionalStringFlag(flags, 'order-by')
  if (
    value === undefined ||
    value === 'createdAt' ||
    value === 'updatedAt' ||
    value === 'sortOrder'
  ) {
    return value
  }
  throw new RuntimeClientError(
    'invalid_argument',
    '--order-by must be createdAt, updatedAt, or sortOrder'
  )
}

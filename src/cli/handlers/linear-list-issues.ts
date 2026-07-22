import type {
  LinearMcpIssueListRequest,
  LinearMcpIssueListResult
} from '../../shared/linear-agent-access'
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
  const request: LinearMcpIssueListRequest = {
    team: getOptionalStringFlag(flags, 'team'),
    cycle: getOptionalStringFlag(flags, 'cycle'),
    label: getOptionalStringFlag(flags, 'label'),
    limit: getOptionalPositiveIntegerFlag(flags, 'limit'),
    query: getOptionalStringFlag(flags, 'query'),
    state: getOptionalStringFlag(flags, 'state'),
    cursor: getOptionalStringFlag(flags, 'cursor'),
    orderBy: getOrderBy(flags),
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

function getOrderBy(flags: Map<string, string | boolean>): LinearMcpIssueListRequest['orderBy'] {
  const value = getOptionalStringFlag(flags, 'order-by')
  if (value === undefined || value === 'createdAt' || value === 'updatedAt') {
    return value
  }
  throw new RuntimeClientError('invalid_argument', '--order-by must be createdAt or updatedAt')
}

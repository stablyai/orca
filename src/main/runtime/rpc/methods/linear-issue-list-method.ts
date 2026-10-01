import type { z } from 'zod'
import { defineMethod } from '../core'
import { ListIssues, McpListIssues } from '../../../../shared/rpc-contract/linear-issue-list-params'

export const LINEAR_ISSUE_LIST_METHOD = defineMethod({
  name: 'linear.listIssues',
  params: ListIssues,
  handler: async (params, { runtime }) => {
    if (isMcpIssueListRequest(params)) {
      return runtime.linearMcpIssueList(params)
    }
    return runtime.linearListIssues(params?.filter, params?.limit, params?.workspaceId, {
      attributeFilter: params?.attributeFilter
    })
  }
})

export const LINEAR_MCP_ISSUE_LIST_METHOD = defineMethod({
  name: 'linear.mcpListIssues',
  params: McpListIssues,
  handler: async (params, { runtime }) => runtime.linearMcpIssueList(params)
})

const MCP_ISSUE_LIST_KEYS = [
  'team',
  'cycle',
  'label',
  'query',
  'state',
  'cursor',
  'orderBy',
  'project',
  'release',
  'assignee',
  'delegate',
  'parentId',
  'priority',
  'createdAt',
  'updatedAt',
  'includeArchived'
] as const

function isMcpIssueListRequest(
  params: z.infer<typeof ListIssues>
): params is z.infer<typeof McpListIssues> {
  return Boolean(params && MCP_ISSUE_LIST_KEYS.some((key) => key in params))
}

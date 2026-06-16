import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import { OptionalFiniteNumber, OptionalString, requiredString } from '../schemas'
import { linearError } from '../../../linear/issue-context-errors'
import { isLinearUuid } from '../../../../shared/linear-uuid'

const LINEAR_DUE_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const LinearDueDate = z.string().refine((value) => LINEAR_DUE_DATE_PATTERN.test(value), {
  message: 'Linear due dates must use YYYY-MM-DD'
})
const OptionalLinearDueDate = LinearDueDate.optional()
const OptionalLinearDueDateOrClear = z.union([LinearDueDate, z.null()]).optional()

const AgentSearchIssues = z.object({
  query: requiredString('Missing query'),
  limit: OptionalFiniteNumber,
  workspaceId: z.union([z.string(), z.literal('all')]).optional()
})

const LinearWorkspaceRead = z.object({
  workspaceId: z.union([z.string(), z.literal('all')]).optional()
})

const LinearTeamLookup = z.object({
  teamInput: requiredString('Missing team'),
  workspaceId: OptionalString.refine((value) => value !== 'all', {
    message: '--workspace all is only valid for team list'
  })
})

const LinearIssueList = z.object({
  filter: z.enum(['assigned', 'created', 'all', 'completed', 'open']).optional(),
  teamInput: OptionalString,
  limit: OptionalFiniteNumber,
  workspaceId: z.union([z.string(), z.literal('all')]).optional()
})

const LinearProjectList = z.object({
  query: OptionalString,
  limit: OptionalFiniteNumber,
  workspaceId: z.union([z.string(), z.literal('all')]).optional()
})

const LinearIncludeFlags = z.object({
  comments: z.boolean(),
  children: z.boolean(),
  attachments: z.boolean(),
  relations: z.boolean()
})

const LinearCurrentContext = z
  .object({
    worktreeId: OptionalString,
    terminalHandle: OptionalString,
    cwd: OptionalString,
    remote: z.boolean().optional()
  })
  .optional()

const LinearWriteTarget = z.object({
  input: OptionalString,
  current: z.boolean().optional(),
  workspaceId: OptionalString.refine((value) => value !== 'all', {
    message: '--workspace all is not valid for Linear writes'
  }),
  context: LinearCurrentContext
})

const AgentIssueContext = z.object({
  input: OptionalString,
  current: z.boolean().optional(),
  workspaceId: OptionalString,
  include: LinearIncludeFlags,
  depth: z.number().int().min(0).max(5),
  context: LinearCurrentContext
})

const LinearIssueSetState = LinearWriteTarget.extend({
  to: requiredString('Missing target state')
})

const LinearIssueUpdateTask = LinearWriteTarget.extend({
  operation: z.enum(['assignee', 'priority', 'estimate', 'dueDate', 'labels']),
  assigneeId: z.string().nullable().optional(),
  assigneeMe: z.boolean().optional(),
  priority: z.number().int().min(0).max(4).optional(),
  estimate: z.number().int().min(0).nullable().optional(),
  dueDate: OptionalLinearDueDateOrClear,
  labelMode: z.enum(['add', 'remove', 'set']).optional(),
  labels: z.array(z.string()).optional()
})

const LinearIssueAddComment = LinearWriteTarget.extend({
  body: requiredString('Missing comment body'),
  replyTo: OptionalString,
  writeId: OptionalString
})

const LinearIssueAttachLink = LinearWriteTarget.extend({
  url: requiredString('Missing attachment URL'),
  title: OptionalString,
  writeId: OptionalString
})

const LinearIssueCreate = z.object({
  title: requiredString('Missing issue title'),
  body: OptionalString,
  teamInput: OptionalString,
  teamKey: OptionalString,
  state: OptionalString,
  assignee: OptionalString,
  priority: z.number().int().min(0).max(4).optional(),
  estimate: z.number().int().min(0).optional(),
  dueDate: OptionalLinearDueDate,
  labels: z.array(z.string()).optional(),
  projectInput: OptionalString,
  parentInput: OptionalString,
  parentCurrent: z.boolean().optional(),
  workspaceId: OptionalString.refine((value) => value !== 'all', {
    message: '--workspace all is not valid for Linear writes'
  }),
  writeId: OptionalString,
  context: LinearCurrentContext
})

function parseLinearWriteId(writeId: string | undefined): string | undefined {
  if (writeId === undefined) {
    return undefined
  }
  if (!isLinearUuid(writeId)) {
    throw linearError('linear_invalid_write_id', '--write-id must be a UUID')
  }
  return writeId
}

export const LINEAR_AGENT_ACCESS_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'linear.agentSearchIssues',
    params: AgentSearchIssues,
    handler: async (params, { runtime }) =>
      runtime.linearSearchForAgents({
        query: params.query,
        limit: params.limit,
        workspaceId: params.workspaceId
      })
  }),
  defineMethod({
    name: 'linear.issueContext',
    params: AgentIssueContext,
    handler: async (params, { runtime }) => runtime.linearIssueContext(params)
  }),
  defineMethod({
    name: 'linear.agentTeamList',
    params: LinearWorkspaceRead,
    handler: async (params, { runtime }) => runtime.linearTeamListForAgents(params)
  }),
  defineMethod({
    name: 'linear.agentTeamMembers',
    params: LinearTeamLookup,
    handler: async (params, { runtime }) => runtime.linearTeamMembersForAgents(params)
  }),
  defineMethod({
    name: 'linear.agentTeamStates',
    params: LinearTeamLookup,
    handler: async (params, { runtime }) => runtime.linearTeamStatesForAgents(params)
  }),
  defineMethod({
    name: 'linear.agentTeamLabels',
    params: LinearTeamLookup,
    handler: async (params, { runtime }) => runtime.linearTeamLabelsForAgents(params)
  }),
  defineMethod({
    name: 'linear.agentIssueList',
    params: LinearIssueList,
    handler: async (params, { runtime }) => runtime.linearIssueListForAgents(params)
  }),
  defineMethod({
    name: 'linear.agentProjectList',
    params: LinearProjectList,
    handler: async (params, { runtime }) => runtime.linearProjectListForAgents(params)
  }),
  defineMethod({
    name: 'linear.resolveCurrentIssue',
    params: LinearCurrentContext,
    handler: async (params, { runtime }) => runtime.linearResolveCurrentIssue(params)
  }),
  defineMethod({
    name: 'linear.issueSetState',
    params: LinearIssueSetState,
    handler: async (params, { runtime }) => runtime.linearIssueSetState(params)
  }),
  defineMethod({
    name: 'linear.issueUpdateTask',
    params: LinearIssueUpdateTask,
    handler: async (params, { runtime }) => runtime.linearIssueUpdateTask(params)
  }),
  defineMethod({
    name: 'linear.issueAddComment',
    params: LinearIssueAddComment,
    handler: async (params, { runtime }) =>
      runtime.linearIssueAddComment({ ...params, writeId: parseLinearWriteId(params.writeId) })
  }),
  defineMethod({
    name: 'linear.issueAttachLink',
    params: LinearIssueAttachLink,
    handler: async (params, { runtime }) =>
      runtime.linearIssueAttachLink({ ...params, writeId: parseLinearWriteId(params.writeId) })
  }),
  defineMethod({
    name: 'linear.issueCreate',
    params: LinearIssueCreate,
    handler: async (params, { runtime }) =>
      runtime.linearIssueCreate({ ...params, writeId: parseLinearWriteId(params.writeId) })
  })
]

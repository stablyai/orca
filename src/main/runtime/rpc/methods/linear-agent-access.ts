import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import { OptionalFiniteNumber, OptionalString, requiredString } from '../schemas'
import { linearError } from '../../../linear/issue-context-errors'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const AgentSearchIssues = z.object({
  query: requiredString('Missing query'),
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
  teamKey: OptionalString,
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
  if (!UUID_PATTERN.test(writeId)) {
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

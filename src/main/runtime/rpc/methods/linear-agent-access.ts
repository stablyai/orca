import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import { OptionalFiniteNumber, OptionalString, requiredString } from '../schemas'

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

const AgentIssueContext = z.object({
  input: OptionalString,
  current: z.boolean().optional(),
  workspaceId: OptionalString,
  include: LinearIncludeFlags,
  depth: z.number().int().min(0).max(5),
  context: LinearCurrentContext
})

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
  })
]

import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import { OptionalString, requiredString } from '../schemas'
import {
  clampLinearProjectMetadataLimit,
  clampLinearProjectUpdatesLimit
} from '../../../../shared/linear/project-agent-access'

const LinearProjectWorkspace = OptionalString.refine((value) => value !== 'all', {
  message: '--workspace all is only valid for project list, statuses, and labels'
})

// Why: forgiving like the other limit schemas — a non-numeric limit means "unset", not an error.
const LinearProjectMetadataLimit = z
  .unknown()
  .transform((value) =>
    typeof value === 'number' && Number.isFinite(value)
      ? clampLinearProjectMetadataLimit(value)
      : undefined
  )
  .pipe(z.union([z.number(), z.undefined()]))
  .optional()

const LinearProjectUpdatesLimit = z
  .number()
  .refine((value) => Number.isInteger(value) && value >= 1, {
    message: '--updates-limit must be a positive integer'
  })
  .transform((value) => clampLinearProjectUpdatesLimit(value))
  .optional()

const LinearProjectShow = z
  .object({
    input: requiredString('Missing project').refine((value) => value.trim().length > 0, {
      message: 'Missing project'
    }),
    workspaceId: LinearProjectWorkspace,
    updates: z.boolean().optional(),
    updatesLimit: LinearProjectUpdatesLimit
  })
  .refine((params) => params.updatesLimit === undefined || params.updates === true, {
    message: '--updates-limit requires --updates',
    path: ['updatesLimit']
  })

const LinearProjectWorkspaceRead = z.object({
  query: OptionalString,
  limit: LinearProjectMetadataLimit,
  workspaceId: z.union([z.string(), z.literal('all')]).optional()
})

export const LINEAR_AGENT_PROJECT_READ_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'linear.agentProjectShow',
    params: LinearProjectShow,
    handler: async (params, { runtime }) =>
      runtime.linearProjectShowForAgents({ ...params, input: params.input.trim() })
  }),
  defineMethod({
    name: 'linear.agentProjectStatuses',
    params: LinearProjectWorkspaceRead,
    handler: async (params, { runtime }) => runtime.linearProjectStatusesForAgents(params)
  }),
  defineMethod({
    name: 'linear.agentProjectLabels',
    params: LinearProjectWorkspaceRead,
    handler: async (params, { runtime }) => runtime.linearProjectLabelsForAgents(params)
  })
]

import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import { OptionalString, requiredString } from '../schemas'
import { linearError } from '../../../linear/issue-context-errors'
import { normalizeLinearLineEndings } from '../../../linear/linear-text-digest'
import { isLinearUuid } from '../../../../shared/linear/uuid'
import { LINEAR_PROJECT_UPDATE_HEALTH_API_VALUES } from '../../../../shared/linear/project-agent-access'

const LinearProjectWriteWorkspace = OptionalString.refine((value) => value !== 'all', {
  message: '--workspace all is only valid for project list, statuses, and labels'
})

const LinearProjectTarget = requiredString('Missing project').refine(
  (value) => value.trim().length > 0,
  { message: 'Missing project' }
)

// Why: OptionalString coerces '' to undefined, which would hide an empty body from this check.
const LinearProjectUpdateBody = z
  .string()
  .refine((value) => normalizeLinearLineEndings(value).length > 0, {
    message: 'Missing update body'
  })

const LinearProjectUpdateAdd = z.object({
  input: LinearProjectTarget,
  workspaceId: LinearProjectWriteWorkspace,
  body: LinearProjectUpdateBody,
  // Why: the CLI normalizes on-track/at-risk/off-track; the wire carries only the API spellings.
  health: z.enum(LINEAR_PROJECT_UPDATE_HEALTH_API_VALUES).optional(),
  isDiffHidden: z.boolean().optional(),
  writeId: OptionalString
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

export const LINEAR_AGENT_PROJECT_WRITE_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'linear.agentProjectUpdateAdd',
    params: LinearProjectUpdateAdd,
    handler: async (params, { runtime }) =>
      // Why: re-normalize here so a direct RPC caller gets the CLI's intent and digest contract.
      runtime.linearProjectUpdateAddForAgents({
        ...params,
        input: params.input.trim(),
        body: normalizeLinearLineEndings(params.body),
        writeId: parseLinearWriteId(params.writeId)
      })
  })
]

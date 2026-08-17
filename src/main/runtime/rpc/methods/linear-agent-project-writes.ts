import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import { OptionalPlainString, OptionalString, requiredString } from '../schemas'
import { linearError } from '../../../linear/issue-context-errors'
import { normalizeLinearLineEndings } from '../../../linear/linear-text-digest'
import { isLinearUuid, isLinearUuidV4 } from '../../../../shared/linear/uuid'
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

// Why: references travel as user-input strings only; the host that owns the token resolves them.
const LinearProjectReference = z.string().refine((value) => value.trim().length > 0, {
  message: 'Reference values cannot be blank'
})

const LinearProjectCreate = z.object({
  name: requiredString('Missing project name').refine((value) => value.trim().length > 0, {
    message: 'Missing project name'
  }),
  teams: z.array(LinearProjectReference).min(1, 'At least one team is required'),
  // Why: OptionalString coerces '' to undefined, and empty prose is a meaningful create value.
  description: OptionalPlainString,
  content: OptionalPlainString,
  status: OptionalString,
  lead: OptionalString,
  members: z.array(LinearProjectReference).optional(),
  labels: z.array(LinearProjectReference).optional(),
  // Why: 0 is `none`, a real requested priority, so the bounds must include it.
  priority: z.number().int().min(0).max(4).optional(),
  startDate: OptionalString.refine(isOptionalCalendarDate, {
    message: '--start-date must be a real YYYY-MM-DD date'
  }),
  targetDate: OptionalString.refine(isOptionalCalendarDate, {
    message: '--target-date must be a real YYYY-MM-DD date'
  }),
  color: OptionalString.refine((value) => value === undefined || /^#[0-9A-Fa-f]{6}$/.test(value), {
    message: '--color must be #RRGGBB'
  }),
  icon: OptionalString,
  writeId: OptionalString,
  workspaceId: LinearProjectWriteWorkspace
})

function isOptionalCalendarDate(value: string | undefined): boolean {
  if (value === undefined) {
    return true
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false
  }
  // Why: the regex accepts 2026-02-31; only a round-trip proves a real calendar date.
  return new Date(`${value}T00:00:00.000Z`).toISOString().startsWith(value)
}

function parseLinearWriteId(writeId: string | undefined): string | undefined {
  if (writeId === undefined) {
    return undefined
  }
  if (!isLinearUuid(writeId)) {
    throw linearError('linear_invalid_write_id', '--write-id must be a UUID')
  }
  return writeId
}

/** `ProjectCreateInput.id` is documented as UUID v4, unlike every other write id. */
function parseLinearProjectCreateWriteId(writeId: string | undefined): string | undefined {
  if (writeId === undefined) {
    return undefined
  }
  if (!isLinearUuidV4(writeId)) {
    throw linearError('linear_invalid_write_id', '--write-id must be a UUID v4 for project create')
  }
  return writeId
}

export const LINEAR_AGENT_PROJECT_WRITE_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'linear.agentProjectCreate',
    params: LinearProjectCreate,
    handler: async (params, { runtime }) =>
      // Why: re-normalize here so a direct RPC caller gets the CLI's intent and digest contract.
      runtime.linearProjectCreateForAgents({
        ...params,
        name: params.name.trim(),
        ...(params.description !== undefined
          ? { description: normalizeLinearLineEndings(params.description) }
          : {}),
        ...(params.content !== undefined
          ? { content: normalizeLinearLineEndings(params.content) }
          : {}),
        writeId: parseLinearProjectCreateWriteId(params.writeId)
      })
  }),
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

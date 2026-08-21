import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import { OptionalPlainString, OptionalString, requiredString } from '../schemas'
import { linearError } from '../../../linear/issue-context-errors'
import { normalizeLinearLineEndings } from '../../../linear/linear-text-digest'
import { isLinearUuid, isLinearUuidV4 } from '../../../../shared/linear/uuid'
import { LINEAR_PROJECT_UPDATE_HEALTH_API_VALUES } from '../../../../shared/linear/project-agent-access'
import { LINEAR_PROJECT_EDITABLE_FIELDS } from '../../../../shared/linear/project-agent-writes'

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

// Why: each reference costs one sequential Linear round-trip on a shared limiter, so an
// oversized array pins Linear access for every caller. Sized to the 30s resolution
// deadline: three reference fields at ~200ms per round-trip leaves room for ~50 each,
// and anything past that would only fail closed on the deadline instead of writing.
// Resolving them concurrently over the limiter's four permits would lift this.
const LINEAR_PROJECT_REFERENCE_CAP = 50
function referenceList(field: string) {
  return z
    .array(LinearProjectReference)
    .max(
      LINEAR_PROJECT_REFERENCE_CAP,
      `${field} accepts at most ${LINEAR_PROJECT_REFERENCE_CAP} values`
    )
}

const LinearProjectCreate = z.object({
  name: requiredString('Missing project name').refine((value) => value.trim().length > 0, {
    message: 'Missing project name'
  }),
  teams: referenceList('teams').min(1, 'At least one team is required'),
  // Why: OptionalString coerces '' to undefined, and empty prose is a meaningful create value.
  description: OptionalPlainString,
  content: OptionalPlainString,
  status: OptionalString,
  lead: OptionalString,
  members: referenceList('members').optional(),
  labels: referenceList('labels').optional(),
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
  writeId: OptionalString,
  workspaceId: LinearProjectWriteWorkspace
})

// Why: null is the explicit clear for these fields, and OptionalString would erase it to undefined.
const NullableString = z.union([z.string(), z.null()]).optional()

function nullableCalendarDate(flag: string) {
  return NullableString.refine((value) => value === null || isOptionalCalendarDate(value), {
    message: `--${flag} must be a real YYYY-MM-DD date`
  })
}

const LinearProjectEdit = z
  .object({
    input: LinearProjectTarget,
    workspaceId: LinearProjectWriteWorkspace,
    // Why: OptionalPlainString keeps '' so a blank name is rejected instead of read as absent.
    name: OptionalPlainString.refine((value) => value === undefined || value.trim().length > 0, {
      message: 'Missing project name'
    }),
    description: OptionalPlainString,
    content: NullableString,
    status: OptionalString,
    lead: NullableString,
    members: referenceList('members').optional(),
    // Why: members and labels clear with [], but a team replacement must keep at least one team.
    teams: referenceList('teams').min(1, 'At least one team is required').optional(),
    labels: referenceList('labels').optional(),
    priority: z.number().int().min(0).max(4).optional(),
    startDate: nullableCalendarDate('start-date'),
    targetDate: nullableCalendarDate('target-date'),
    color: OptionalString.refine(
      (value) => value === undefined || /^#[0-9A-Fa-f]{6}$/.test(value),
      {
        message: '--color must be #RRGGBB'
      }
    )
  })
  .refine((params) => LINEAR_PROJECT_EDITABLE_FIELDS.some((field) => params[field] !== undefined), {
    message: 'At least one field to edit is required'
  })

function isOptionalCalendarDate(value: string | undefined): boolean {
  if (value === undefined) {
    return true
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) {
    return false
  }
  // Why: the regex accepts 2026-02-31, so only a round-trip proves a real calendar
  // date — built via Date.UTC because parsing an out-of-range month makes an Invalid
  // Date whose toISOString() throws, and a throw inside refine() escapes safeParse.
  const [year, month, day] = match.slice(1).map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  )
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
    name: 'linear.agentProjectEdit',
    params: LinearProjectEdit,
    handler: async (params, { runtime }) =>
      // Why: re-normalize here so a direct RPC caller gets the CLI's intent and digest contract.
      runtime.linearProjectEditForAgents({
        ...params,
        input: params.input.trim(),
        ...(params.name !== undefined ? { name: params.name.trim() } : {}),
        ...(params.description !== undefined
          ? { description: normalizeLinearLineEndings(params.description) }
          : {}),
        ...(typeof params.content === 'string'
          ? { content: normalizeLinearLineEndings(params.content) }
          : {})
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

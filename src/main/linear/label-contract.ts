import { z } from 'zod'

import type {
  LinearIssueLabelCreateInput,
  LinearIssueLabelUpdateInput,
  LinearWorkspaceSelection
} from '../../shared/types'

function optionalTrimmedString(label: string) {
  return z
    .unknown()
    .optional()
    .transform((value, ctx) => {
      if (value === undefined) {
        return undefined
      }
      if (typeof value !== 'string') {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${label} must be a string` })
        return undefined
      }
      return value.trim() || undefined
    })
}

function optionalNullableTrimmedString(label: string) {
  return z
    .unknown()
    .optional()
    .transform((value, ctx) => {
      if (value === undefined) {
        return undefined
      }
      if (value === null) {
        return null
      }
      if (typeof value !== 'string') {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${label} must be a string or null` })
        return undefined
      }
      return value.trim() || undefined
    })
}

function requiredTrimmedString(label: string) {
  return z.unknown().transform((value, ctx) => {
    if (typeof value !== 'string' || !value.trim()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${label} is required` })
      return ''
    }
    return value.trim()
  })
}

function optionalTrimmedNonBlankString(label: string) {
  return z
    .unknown()
    .optional()
    .transform((value, ctx) => {
      if (value === undefined) {
        return undefined
      }
      if (typeof value !== 'string') {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${label} must be a string` })
        return undefined
      }
      const trimmed = value.trim()
      if (!trimmed) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${label} is required` })
        return undefined
      }
      return trimmed
    })
}

function optionalBoolean(label: string) {
  return z
    .unknown()
    .optional()
    .transform((value, ctx) => {
      if (value === undefined) {
        return undefined
      }
      if (typeof value !== 'boolean') {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${label} must be a boolean` })
        return undefined
      }
      return value
    })
}

export const LinearWorkspaceIdSchema = optionalTrimmedString('Workspace ID')
export const LinearWorkspaceSelectionSchema = LinearWorkspaceIdSchema.transform(
  (value) => value as LinearWorkspaceSelection | undefined
)

export const LinearIssueLabelListArgsSchema = z
  .object({
    workspaceId: LinearWorkspaceSelectionSchema,
    teamId: optionalTrimmedString('Label team ID'),
    includeArchived: optionalBoolean('includeArchived')
  })
  .optional()
  .transform((value) => ({
    workspaceId: value?.workspaceId,
    teamId: value?.teamId,
    includeArchived: value?.includeArchived === true
  }))

export const LinearIssueLabelCreateInputSchema = z.object({
  name: requiredTrimmedString('Label name'),
  color: optionalTrimmedString('Label color'),
  description: optionalNullableTrimmedString('Label description'),
  teamId: optionalNullableTrimmedString('Label team ID'),
  parentId: optionalNullableTrimmedString('Label parent ID'),
  isGroup: optionalBoolean('Label group flag')
}) satisfies z.ZodType<LinearIssueLabelCreateInput>

export const LinearIssueLabelUpdateInputSchema = z.object({
  name: optionalTrimmedNonBlankString('Label name'),
  color: optionalTrimmedString('Label color'),
  description: optionalNullableTrimmedString('Label description'),
  parentId: optionalNullableTrimmedString('Label parent ID'),
  isGroup: optionalBoolean('Label group flag')
}) satisfies z.ZodType<LinearIssueLabelUpdateInput>

export const LinearIssueLabelIdArgsSchema = z.object({
  id: requiredTrimmedString('Label ID'),
  workspaceId: LinearWorkspaceIdSchema
})

export const LinearIssueLabelCreateArgsSchema = z.object({
  workspaceId: LinearWorkspaceIdSchema,
  input: LinearIssueLabelCreateInputSchema
})

export const LinearIssueLabelUpdateArgsSchema = z.object({
  id: requiredTrimmedString('Label ID'),
  workspaceId: LinearWorkspaceIdSchema,
  input: LinearIssueLabelUpdateInputSchema
})

export function parseLinearLabelPayload<T>(
  schema: z.ZodType<T>,
  value: unknown
): { ok: true; value: T } | { ok: false; error: string } {
  const result = schema.safeParse(value)
  if (result.success) {
    return { ok: true, value: result.data }
  }
  return { ok: false, error: result.error.issues[0]?.message ?? 'Invalid Linear label payload' }
}

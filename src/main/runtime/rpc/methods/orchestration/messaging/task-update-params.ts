import { z } from 'zod'
import { lazyZodSchema } from '../../../../../../shared/schema/lazy-zod-schema'
import { OptionalString } from '../../../../../../shared/rpc-contract/rpc-param-primitives'
import { ORCHESTRATION_PROGRESS_NOTE_MAX } from '../../../../../../shared/rpc-contract/orchestration/orchestration-params'

export const TASK_UPDATE_STATUSES = [
  'pending',
  'ready',
  'dispatched',
  'completed',
  'failed',
  'blocked'
] as const

export const TaskUpdateParams = lazyZodSchema(() =>
  z
    .object({
      id: OptionalString,
      status: z
        .enum(TASK_UPDATE_STATUSES, {
          error: `Invalid --status; expected one of: ${TASK_UPDATE_STATUSES.join(', ')}`
        })
        .optional(),
      result: OptionalString,
      note: z
        .string()
        .trim()
        .min(1, '--note cannot be empty.')
        .max(
          ORCHESTRATION_PROGRESS_NOTE_MAX,
          `Progress note must be at most ${ORCHESTRATION_PROGRESS_NOTE_MAX} characters.`
        )
        .optional(),
      run: OptionalString,
      callerTerminalHandle: OptionalString,
      senderPaneKey: OptionalString
    })
    .superRefine((params, ctx) => {
      if (params.status === undefined && params.note === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Choose --status, --note, or both.'
        })
      }
      if (params.status === undefined && params.result !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: '--result requires --status.'
        })
      }
    })
)

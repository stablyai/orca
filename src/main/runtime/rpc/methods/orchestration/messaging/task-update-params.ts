import { z } from 'zod'
import { lazyZodSchema } from '../../../../../../shared/schema/lazy-zod-schema'
import { OptionalString } from '../../../../../../shared/rpc-contract/rpc-param-primitives'
import { ORCHESTRATION_PROGRESS_NOTE_MAX } from '../../../../../../shared/rpc-contract/orchestration/orchestration-params'

const TASK_STATUSES = ['pending', 'ready', 'dispatched', 'completed', 'failed', 'blocked'] as const

export const TaskUpdateParams = lazyZodSchema(() =>
  z
    .object({
      id: OptionalString,
      status: z
        .enum(TASK_STATUSES, {
          error: `Invalid --status; expected one of: ${TASK_STATUSES.join(', ')}`
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
      const hasStatus = params.status !== undefined
      const hasNote = params.note !== undefined
      if (hasStatus === hasNote) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: hasStatus
            ? '--note is for passive worker updates and cannot be combined with --status.'
            : 'Choose --status or --note.'
        })
        return
      }
      if (hasStatus && !params.id) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Missing --id' })
      }
      if (hasNote && params.result !== undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: '--result requires --status.' })
      }
    })
)

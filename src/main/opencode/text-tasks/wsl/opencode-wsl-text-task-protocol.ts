import { z } from 'zod'

export const OPENCODE_WSL_TEXT_TASK_REQUEST_MAX_BYTES = 32 * 1024 * 1024
/** Session interrupt/delete plus the provider supervisor's full stop, with margin. */
export const OPENCODE_WSL_TEXT_TASK_CLEANUP_MS = 15_000

export const openCodeWslTextTaskResult = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), text: z.string() }),
  z.object({ ok: z.literal(false), stage: z.enum(['startup', 'session', 'superseded', 'aborted']) })
])

export type OpenCodeWslTextTaskResult = z.infer<typeof openCodeWslTextTaskResult>

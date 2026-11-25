import { z } from 'zod'

export type OpenCodePromptFailureQuery = {
  dbPath: string
  sessionId: string
  startedAt: number
  failedAt: number
}

export const openCodePromptFailureSchema = z.object({
  inputId: z.string().min(1).max(256),
  type: z.string().min(1).max(128),
  message: z.string().min(1).max(4096),
  status: z.number().int().min(100).max(599).optional(),
  resetsAt: z.number().int().positive().optional(),
  responseType: z.string().max(128).optional(),
  responseMessage: z.string().max(4096).optional()
})

export type OpenCodePromptFailure = z.infer<typeof openCodePromptFailureSchema>
export type OpenCodePromptFailureResult = { failure: OpenCodePromptFailure | null }

export function parseOpenCodePromptFailureResult(
  value: unknown
): OpenCodePromptFailureResult | null {
  const parsed = z.object({ failure: openCodePromptFailureSchema.nullable() }).safeParse(value)
  return parsed.success ? parsed.data : null
}

export function openCodePromptFailureUnavailable(): OpenCodePromptFailureResult {
  return { failure: null }
}

import { z } from 'zod'

export const roomProviderSessionSchema = z
  .object({
    key: z.enum(['session_id', 'conversation_id']),
    id: z.string(),
    transcriptPath: z.string().optional(),
    transport: z.literal('machine').optional(),
    sourceSessionId: z.string().optional()
  })
  .passthrough()
  .nullable()

export const roomContextSchema = z
  .object({
    model: z.string().nullable(),
    effort: z.string().nullable(),
    fastMode: z.boolean().nullable(),
    usedTokens: z.number().nullable(),
    maxTokens: z.number().nullable(),
    remainingTokens: z.number().nullable(),
    usedPercent: z.number().nullable(),
    estimated: z.boolean(),
    source: z.enum(['provider', 'hook', 'statusline', 'unavailable']),
    observedAt: z.number().nullable(),
    compaction: z.enum(['idle', 'requested', 'running', 'completed', 'failed']),
    compactionUpdatedAt: z.number().nullable(),
    error: z.string()
  })
  .partial()
  .passthrough()

export const roomMetadataSchema = z.record(z.string(), z.unknown())
export const roomAttemptHistorySchema = z.array(
  z
    .object({
      attempt: z.number(),
      phase: z.enum(['waking', 'submitting', 'awaiting-turn']),
      error: z.string(),
      at: z.number()
    })
    .passthrough()
)

export function parseRoomJson<T>(value: unknown, schema: z.ZodType<T>, fallback: T): T {
  if (typeof value !== 'string' || value.length === 0) {
    return fallback
  }
  try {
    const parsed = schema.safeParse(JSON.parse(value))
    return parsed.success ? parsed.data : fallback
  } catch {
    return fallback
  }
}

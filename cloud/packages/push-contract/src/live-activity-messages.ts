import { z } from 'zod'

export const LiveActivitySendSchema = z.object({
  token: z.string().min(2).max(4096).regex(/^(?:[a-f0-9]{2})+$/i),
  apnsEnvironment: z.enum(['sandbox', 'production']),
  timestamp: z.number().int().positive(),
  event: z.enum(['update', 'end']),
  content: z.object({
    state: z.enum(['working', 'attention', 'done', 'failed', 'unavailable']),
    title: z.string().min(1).max(80),
    stateStartedAt: z.number().nonnegative(),
    updatedAt: z.number().nonnegative()
  }).strict()
}).strict()

export type LiveActivitySend = z.infer<typeof LiveActivitySendSchema>

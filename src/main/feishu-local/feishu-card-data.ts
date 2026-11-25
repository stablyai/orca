import { z } from 'zod'

export const cardData = z.object({
  kind: z.enum(['status', 'prompt', 'choices', 'async-question']),
  text: z.string(),
  options: z
    .array(z.object({ id: z.string(), label: z.string(), answer: z.string().optional() }))
    .default([]),
  promptId: z.string().optional(),
  sessionId: z.string().optional(),
  note: z.string().optional()
})
export type FeishuCardData = z.infer<typeof cardData>

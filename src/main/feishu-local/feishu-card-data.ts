import { z } from 'zod'

export const cardData = z.object({
  kind: z.enum(['status', 'prompt', 'choices']),
  text: z.string(),
  options: z.array(z.object({ id: z.string(), label: z.string() })).default([]),
  promptId: z.string().optional(),
  note: z.string().optional()
})
export type FeishuCardData = z.infer<typeof cardData>

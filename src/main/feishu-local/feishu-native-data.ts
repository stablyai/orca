import { z } from 'zod'
export const nativeStep = z.object({
  id: z.string(),
  title: z.string(),
  detail: z.string(),
  iconToken: z.string(),
  status: z.enum(['running', 'success', 'error']),
  durationMs: z.number().optional()
})
export const nativeResponse = z.object({
  turnItemId: z.string(),
  startedAt: z.number(),
  completedAt: z.number().optional(),
  messages: z.array(z.object({ id: z.string(), text: z.string() })),
  tools: z.array(nativeStep)
})
export type FeishuNativeResponse = z.infer<typeof nativeResponse>

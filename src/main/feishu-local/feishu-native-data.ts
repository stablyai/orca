import { lazyZodSchema } from '../../shared/schema/lazy-zod-schema'
import { z } from 'zod'
export const nativeStep = lazyZodSchema(() =>
  z.object({
    id: z.string(),
    title: z.string(),
    detail: z.string(),
    iconToken: z.string(),
    status: z.enum(['running', 'success', 'error']),
    durationMs: z.number().optional()
  })
)
export const nativeResponse = lazyZodSchema(() =>
  z.object({
    turnItemId: z.string(),
    startedAt: z.number(),
    completedAt: z.number().optional(),
    deliveries: z.array(z.string()).optional(),
    workers: z.array(z.string()).optional(),
    report: z.literal(true).optional(),
    resumed: z.literal(true).optional(),
    failed: z.literal(true).optional(),
    messages: z.array(z.object({ id: z.string(), text: z.string() })),
    tools: z.array(nativeStep)
  })
)
export type FeishuNativeResponse = z.infer<typeof nativeResponse>

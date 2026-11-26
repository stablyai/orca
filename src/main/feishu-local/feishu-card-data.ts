import { z } from 'zod'
import { nativeResponse, type FeishuNativeResponse } from './feishu-native-data'

export const cardData = z.object({
  kind: z.enum(['status', 'prompt', 'choices', 'async-question', 'response']),
  text: z.string(),
  options: z
    .array(z.object({ id: z.string(), label: z.string(), answer: z.string().optional() }))
    .default([]),
  promptId: z.string().optional(),
  sessionId: z.string().optional(),
  note: z.string().optional(),
  response: z
    .object({
      turn: z.number().optional(),
      phase: z.enum(['working', 'done', 'failed']),
      progress: z.array(z.object({ id: z.string(), text: z.string() })),
      trace: z.array(z.string()),
      final: z.string().optional(),
      question: z.object({ id: z.string(), pending: z.boolean() }).optional(),
      native: nativeResponse.optional(),
      baseline: nativeResponse.optional(),
      supersededBy: z.string().optional(),
      stoppedAt: z.number().optional()
    })
    .optional()
})
export type FeishuCardData = z.infer<typeof cardData>

export type FeishuResponseChange =
  | { kind: 'begin' }
  | { kind: 'handoff'; from: string; turnItemId: string; at: number }
  | { kind: 'native'; value: FeishuNativeResponse }
  | { kind: 'start'; turn: number }
  | { kind: 'status'; text: string; turn?: number | null }
  | { kind: 'trace'; text: string; turn: number }
  | { kind: 'progress'; id: string; text: string }
  | { kind: 'final'; text: string; failed?: boolean }

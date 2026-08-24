import { z } from 'zod'
import type { AgentType } from '../../../../shared/native-chat-types'

export const MOBILE_NATIVE_CHAT_MAX_WINDOW = 2000

export const NativeChatSession = z.object({
  agent: z
    .unknown()
    .transform((value) => (typeof value === 'string' ? value : ''))
    .pipe(z.string().min(1, 'Missing agent'))
    .transform((value) => value as AgentType),
  sessionId: z
    .unknown()
    .transform((value) => (typeof value === 'string' ? value : ''))
    .pipe(z.string().min(1, 'Missing session id')),
  limit: z
    .number()
    .int()
    .positive()
    .transform((value) => Math.min(value, MOBILE_NATIVE_CHAT_MAX_WINDOW))
    .optional(),
  subscriptionId: z.string().min(1).optional(),
  transcriptPath: z.string().min(1).optional(),
  paneKey: z.string().min(1).optional(),
  beforeOffset: z.number().int().nonnegative().optional()
})

export const NativeChatUnsubscribe = z.object({
  subscriptionId: z.string().min(1).optional()
})

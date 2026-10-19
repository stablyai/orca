import { z } from 'zod'

export const piRpcModelSchema = z.looseObject({
  id: z.string(),
  provider: z.string(),
  name: z.string().optional(),
  contextWindow: z.number().nonnegative().optional(),
  reasoning: z.boolean().optional(),
  input: z.array(z.string()).optional()
})
export type PiRpcModel = z.infer<typeof piRpcModelSchema>

export const piRpcStateSchema = z.looseObject({
  model: piRpcModelSchema.nullish(),
  thinkingLevel: z.string().optional(),
  sessionFile: z.string().min(1),
  sessionId: z.string().optional(),
  isStreaming: z.boolean(),
  isCompacting: z.boolean(),
  pendingMessageCount: z.number().int().nonnegative().optional()
})
export type PiRpcState = z.infer<typeof piRpcStateSchema>

export function piRpcIdle(state: PiRpcState): boolean {
  return !state.isStreaming && !state.isCompacting && (state.pendingMessageCount ?? 0) === 0
}

export const piRpcContentSchema = z.looseObject({
  type: z.string(),
  text: z.string().optional(),
  thinking: z.string().optional()
})
export const piRpcUsageSchema = z.object({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cacheRead: z.number().nonnegative(),
  cacheWrite: z.number().nonnegative()
})
export const piRpcMessageSchema = z.looseObject({
  role: z.string(),
  content: z.union([z.string(), z.array(piRpcContentSchema)]),
  stopReason: z.string().optional(),
  errorMessage: z.string().optional(),
  usage: piRpcUsageSchema.optional(),
  timestamp: z.number().optional()
})
export const piRpcMessageEventSchema = z.object({
  type: z.enum(['message_start', 'message_update', 'message_end']),
  message: piRpcMessageSchema.optional(),
  usage: piRpcUsageSchema.optional(),
  assistantMessageEvent: z
    .looseObject({
      type: z.string(),
      delta: z.string().optional(),
      contentIndex: z.number().int().nonnegative().optional(),
      partial: piRpcMessageSchema.optional()
    })
    .optional()
})
export type PiRpcMessageEvent = z.infer<typeof piRpcMessageEventSchema>

export const piRpcToolEventSchema = z.object({
  type: z.enum(['tool_execution_start', 'tool_execution_update', 'tool_execution_end']),
  toolCallId: z.string(),
  toolName: z.string(),
  args: z.unknown().optional(),
  partialResult: z.unknown().optional(),
  result: z.unknown().optional(),
  isError: z.boolean().optional()
})
export type PiRpcToolEvent = z.infer<typeof piRpcToolEventSchema>

export const piRpcPromptReplySchema = z.object({
  type: z.literal('response'),
  command: z.literal('prompt'),
  success: z.boolean(),
  error: z.string().optional(),
  data: z
    .object({
      disposition: z.enum(['started', 'queued', 'handled']).optional(),
      agentInvoked: z.boolean().optional()
    })
    .optional()
})

export const piRpcDialogSchema = z.discriminatedUnion('method', [
  z.object({
    id: z.union([z.string(), z.number()]),
    method: z.literal('confirm'),
    title: z.string(),
    message: z.string().optional()
  }),
  z.object({
    id: z.union([z.string(), z.number()]),
    method: z.literal('select'),
    title: z.string(),
    message: z.string().optional(),
    options: z.array(z.string()).min(1).max(64)
  }),
  z.object({
    id: z.union([z.string(), z.number()]),
    method: z.enum(['input', 'editor']),
    title: z.string(),
    message: z.string().optional(),
    placeholder: z.string().optional(),
    prefill: z.string().optional()
  })
])
export type PiRpcDialog = z.infer<typeof piRpcDialogSchema>

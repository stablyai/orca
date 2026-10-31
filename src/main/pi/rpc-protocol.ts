import { z } from 'zod'
import type { JsonlRpcRecord } from '../jsonl-rpc/peer'

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

// The chat never shows these payloads; only their lifecycle step matters.
const LIFECYCLE_ONLY_EVENTS: ReadonlySet<string> = new Set([
  'turn_end',
  'agent_end',
  'compaction_end',
  'auto_compaction_end'
])

// Pi writes these fields before the payload, so they survive in an oversized record's prefix.
const SKIPPED_TOOL_HEAD =
  /^\{"type":"tool_execution_(?:start|update|end)","toolCallId":"([^"\\]+)","toolName":"([^"\\]+)"/
const SKIPPED_MESSAGE_HEAD = /^\{"type":"message_(?:start|end)","message":\{"role":"([A-Za-z]+)"/
const SKIPPED_RETRY_END_HEAD = /^\{"type":"auto_retry_end","success":(true|false)[,}]/

/** What an event over the line limit still applies without its payload, and whether the chat lost content. */
export function piRpcSkippedEvent(
  type: string,
  prefix: string
): { head: JsonlRpcRecord | null; contentLost: boolean } {
  if (LIFECYCLE_ONLY_EVENTS.has(type)) {
    return { head: { type }, contentLost: false }
  }
  const tool = SKIPPED_TOOL_HEAD.exec(prefix)
  const role = SKIPPED_MESSAGE_HEAD.exec(prefix)?.[1]
  const retry = SKIPPED_RETRY_END_HEAD.exec(prefix)?.[1]
  // An oversized tool result is content, not a short error, so an ended call closes as completed.
  const head = tool
    ? { type, toolCallId: tool[1], toolName: tool[2] }
    : role
      ? { type, message: { role, content: [] } }
      : retry
        ? { type, success: retry === 'true' }
        : type === 'message_update' || type === 'auto_retry_start'
          ? { type }
          : null
  return { head, contentLost: true }
}

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

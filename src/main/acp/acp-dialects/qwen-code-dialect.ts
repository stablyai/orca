import { z } from 'zod'
import type { ToolCallUpdate } from '../generated/acp-protocol.generated'
import type { AcpDialect, AcpRequestSettlement } from './acp-dialect'
import { qwenCodeQuestionRequest } from './qwen-code-questions'

// Since 0.24 a shell result is a `shell_result` record; earlier releases send only the output.
const qwenShellResultSchema = z.looseObject({
  type: z.literal('shell_result'),
  output: z.string(),
  exitCode: z.number().int().nullable(),
  error: z.string().nullish()
})

const toolMetaSchema = z.looseObject({ _meta: z.looseObject({ toolName: z.string().min(1) }) })

const preparingCallSchema = z.looseObject({
  _meta: z.looseObject({ phase: z.literal('preparing') })
})

function normalizeToolUpdate(update: ToolCallUpdate): ToolCallUpdate {
  // A call announced while its arguments still stream carries `{}` until it runs.
  if (preparingCallSchema.safeParse(update).success) {
    const { rawInput: _placeholder, ...rest } = update
    return rest
  }
  const result = qwenShellResultSchema.safeParse(update.rawOutput).data
  if (!result) {
    return update
  }
  // The record arrives beside Qwen's own text rendering of it (`Command: …\nExit Code: N`).
  return {
    ...update,
    rawOutput: {
      stdout: result.output,
      // A timeout or a spawn failure explains itself only here.
      ...(result.error ? { stderr: result.error } : {}),
      ...(result.exitCode === null ? {} : { exitCode: result.exitCode })
    },
    content: update.content?.filter(
      (block) => !(block.type === 'content' && block.content.type === 'text')
    )
  }
}

// After each tool Qwen asks for prompts queued mid-turn; Orca queues follow-ups until the turn ends.
// A finished background task asks to start the turn that reports it.
const DETACHED_REPLIES = { 'craft/drainMidTurnQueue': { messages: [], hasQueuedPrompt: false } }

function settleRequest(method: string): AcpRequestSettlement | undefined {
  return method === 'craft/drainMidTurnQueue'
    ? { reply: DETACHED_REPLIES[method] }
    : method === '_qwencode/start_turn'
      ? { reply: { accepted: true } }
      : undefined
}

export const QWEN_CODE_ACP_DIALECT: AcpDialect = {
  normalizeToolUpdate,
  // Titles carry the call's input (`Shell: <command>`); `_meta.toolName` is the tool itself.
  toolName: (update) => toolMetaSchema.safeParse(update).data?._meta.toolName,
  settleRequest,
  detachedReplies: DETACHED_REPLIES,
  request: qwenCodeQuestionRequest,
  reactiveWakeups: true,
  compactCommand: '/compress',
  // Orca's /compact runs /compress, and /clear (also /reset, /new) would empty the session under
  // the chat's transcript.
  withheldCommands: ['compress', 'clear', 'reset', 'new']
}

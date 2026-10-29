import { z } from 'zod'
import type { ToolCallContent, ToolCallUpdate } from '../generated/acp-protocol.generated'
import type { AcpAgentError } from '../acp-errors'
import type { AcpCompactionReply, AcpDialect } from './acp-dialect'

// Read raw result text instead of the repeated command echo in content.
// Only timed foreground completion implies exit zero; service/background launches prove no exit.
const textBlockSchema = z.looseObject({ type: z.literal('text'), text: z.string() })
const promptErrorDataSchema = z.looseObject({ details: z.string() })
const SIGNED_OUT_DETAIL_PREFIXES = ['No model selected.\n\nUse /login', 'No API key found for ']
const CANCEL_CLEANUP_TIMED_OUT = 'ACP cancel cleanup timed out'
const toolResultSchema = z.looseObject({
  content: z.array(z.unknown()),
  details: z
    .looseObject({
      exitCode: z.number().int().safe().optional(),
      wallTimeMs: z.number().nonnegative().optional(),
      timedOut: z.unknown().optional(),
      signal: z.unknown().optional(),
      async: z.unknown().optional(),
      service: z.unknown().optional()
    })
    .optional()
})
const asyncInputSchema = z.looseObject({ async: z.literal(true) })

function contentText(block: ToolCallContent | undefined): string | undefined {
  return block?.type === 'content' && block.content.type === 'text' ? block.content.text : undefined
}

// Exit and timing notices already have dedicated row presentation.
function commandOutput(text: string, exitCode: number | undefined, timed: boolean): string {
  let output = text
  const exitNotice = `\n\nCommand exited with code ${exitCode}`
  if (exitCode !== undefined && output.endsWith(exitNotice)) {
    output = output.slice(0, -exitNotice.length)
  }
  return timed ? output.replace(/\n\nWall time: \d+(?:\.\d+)? seconds$/u, '') : output
}

function normalizeToolUpdate(update: ToolCallUpdate): ToolCallUpdate {
  const echo = contentText(update.content?.[0])
  if (!echo?.startsWith('$ ')) {
    return update
  }
  const parsed = toolResultSchema.safeParse(update.rawOutput)
  if (
    parsed.success &&
    (['exitCode', 'exit_code', 'stdout', 'stderr', 'output_for_prompt'].some(
      (key) => parsed.data[key] !== undefined
    ) ||
      parsed.data.signal != null ||
      parsed.data.timed_out === true)
  ) {
    return update
  }
  const texts = parsed.success
    ? parsed.data.content.flatMap((block) => textBlockSchema.safeParse(block).data?.text ?? [])
    : []
  if (texts.includes(echo)) {
    return update
  }
  // Retain non-output content while moving the raw result text to stdout.
  const content = (update.content ?? []).slice(1).filter((block) => {
    const text = contentText(block)
    return text === undefined || !texts.includes(text)
  })
  if (!parsed.success) {
    return { ...update, content }
  }
  const details = parsed.data.details
  const stdout = commandOutput(
    texts.join('\n'),
    details?.exitCode,
    details?.wallTimeMs !== undefined
  )
  const exitCode =
    details?.exitCode ??
    (update.status === 'completed' &&
    details?.wallTimeMs !== undefined &&
    details?.timedOut !== true &&
    (details?.signal === undefined || details.signal === null) &&
    details?.async === undefined &&
    details?.service === undefined &&
    !asyncInputSchema.safeParse(update.rawInput).success
      ? 0
      : undefined)
  return {
    ...update,
    content,
    rawOutput: { ...parsed.data, stdout, ...(exitCode === undefined ? {} : { exitCode }) }
  }
}

// OMP reports compaction failure and no-ops in a normally completed turn's reply.
const COMPACTION_FAILED = /\bcompaction failed\b/i
const COMPACTION_NOOP = /\b(?:nothing to compact|already compacted)\b/i

function compactionReply(text: string): AcpCompactionReply | undefined {
  const reply = text.trim()
  if (!COMPACTION_FAILED.test(reply)) {
    return undefined
  }
  return COMPACTION_NOOP.test(reply)
    ? { outcome: 'skipped', detail: reply.replace(/^compaction failed:\s*/i, '') }
    : { outcome: 'failed', detail: reply }
}

function errorDetails(error: AcpAgentError): string | undefined {
  return error.code === -32603
    ? promptErrorDataSchema.safeParse(error.data).data?.details
    : undefined
}

export const OMP_ACP_DIALECT: AcpDialect = {
  normalizeToolUpdate,
  compactionReply,
  authenticationRequired: (error) => {
    const details = errorDetails(error)
    return (
      details !== undefined &&
      SIGNED_OUT_DETAIL_PREFIXES.some((prefix) => details.startsWith(prefix))
    )
  },
  // A timed-out cancel cleanup closes the session; later prompts get "Unsupported ACP session".
  sessionLost: (error, sessionId) => {
    const details = errorDetails(error)
    return (
      details === CANCEL_CLEANUP_TIMED_OUT || details === `Unsupported ACP session: ${sessionId}`
    )
  }
}

import { z } from 'zod'
import type { ToolCallContent, ToolCallUpdate } from '../generated/acp-protocol.generated'
import type { AcpAgentError } from '../transport/acp-errors'
import type { AcpCompactionReply, AcpDialect, AcpModelCommandReply } from './acp-dialect'

// Read raw result text instead of the repeated command echo in content.
// Only timed foreground completion implies exit zero; service/background launches prove no exit.
const textBlockSchema = z.looseObject({ type: z.literal('text'), text: z.string() })
const promptErrorDataSchema = z.looseObject({ details: z.string() })
// "No model selected" is not one: a launch selector OMP never resolved says it too (modelNotSelected).
const SIGNED_OUT_DETAIL_PREFIXES = ['No API key found for ']
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
// A task or async bash call reports `details.async.state` running while its job runs; a later frame settles it.
const backgroundJobSchema = z.looseObject({
  details: z.looseObject({
    async: z.looseObject({ state: z.enum(['running', 'completed', 'failed', 'cancelled']) })
  })
})

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

function toolBackgroundJob(update: ToolCallUpdate): 'running' | 'settled' | undefined {
  const state = backgroundJobSchema.safeParse(update.rawOutput).data?.details.async.state
  return state === undefined ? undefined : state === 'running' ? 'running' : 'settled'
}

// OMP reports compaction failure, no-ops and refused arguments in a normally completed turn's reply.
const COMPACTION_FAILED = /\bcompaction failed\b|\bdoes not take focus instructions\b/i
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

// `/model` (builtin-modes.ts) says "Model set to p/id." only after the model and any :level apply.
const MODEL_SET = /^Model set to (\S+)\.$/

function modelCommandReply(text: string): AcpModelCommandReply {
  const reply = text.trim()
  const applied = MODEL_SET.exec(reply)?.[1]
  if (applied) {
    return { applied }
  }
  // A failure after the switch still says "Failed to set model"; the value stays unapplied.
  return {
    refused: /\bNo API key\b/.test(reply) ? 'notSignedIn' : 'modelUnavailable',
    detail: reply
  }
}

function errorDetails(error: AcpAgentError): string | undefined {
  return error.code === -32603
    ? promptErrorDataSchema.safeParse(error.data).data?.details
    : undefined
}

export const OMP_ACP_DIALECT: AcpDialect = {
  // OMP resolves any thinking level against the selected model (model-controls.ts setThinkingLevel).
  clampsUnlistedEffort: true,
  // OMP offers its `ask` tool and extension dialogs only to clients that answer forms.
  clientCapabilities: { elicitation: { form: {} } },
  normalizeToolUpdate,
  toolBackgroundJob,
  compactionReply,
  modelCommand: {
    // #setModelById (acp-agent.ts) takes listed provider/id values only.
    refusedByOption: (error) => errorDetails(error)?.startsWith('Unknown ACP model: ') === true,
    // A launch selector OMP deferred and never resolved leaves the session without a model.
    noModel: (error) => errorDetails(error)?.startsWith('No model selected.') === true,
    // Checked against published packages: 18.1.8's `/model` matches ids, 18.1.9's resolves roles.
    resolvesSelectorsFrom: '18.1.9',
    text: (value) => `/model ${value}`,
    reply: modelCommandReply
  },
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

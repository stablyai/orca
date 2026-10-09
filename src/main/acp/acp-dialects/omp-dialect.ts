import { z } from 'zod'
import type { ToolCallContent, ToolCallUpdate } from '../generated/acp-protocol.generated'
import type { AcpDialect } from './acp-dialect'

// OMP sends a tool's result as `rawOutput: {content: [{type: 'text', text}], details}`, with a
// command's non-zero exit at `details.exitCode`, and repeats the text as content behind a
// `$ <command>` echo. The shared reader takes content text first, so that echo became the output.
// A zero exit is left out; completed foreground results carry wall time, while service and
// background launch results do not establish a process exit.
const textBlockSchema = z.looseObject({ type: z.literal('text'), text: z.string() })
const promptErrorDataSchema = z.looseObject({ details: z.string() })
// OMP's prompt check: no usable model (nothing signed in), or the selected model's provider has no key.
const SIGNED_OUT_DETAIL_PREFIXES = ['No model selected.\n\nUse /login', 'No API key found for ']
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

/** OMP appends these notice lines to a command's output; the row shows exit and timing itself. */
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
  // The result's own text moves to `stdout`; content keeps anything else it carried.
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

export const OMP_ACP_DIALECT: AcpDialect = {
  normalizeToolUpdate,
  authenticationRequired: (error) => {
    const details = promptErrorDataSchema.safeParse(error.data).data?.details
    return (
      error.code === -32603 &&
      details !== undefined &&
      SIGNED_OUT_DETAIL_PREFIXES.some((prefix) => details.startsWith(prefix))
    )
  }
}

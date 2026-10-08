import { z } from 'zod'
import type { ToolCallContent, ToolCallUpdate } from '../generated/acp-protocol.generated'
import type { AcpDialect } from './acp-dialect'

// OMP sends a tool's result as `rawOutput: {content: [{type: 'text', text}], details}`, with a
// command's non-zero exit at `details.exitCode`, and repeats the text as content behind a
// `$ <command>` echo. The shared reader takes content text first, so that echo became the output.
const textBlockSchema = z.looseObject({ type: z.literal('text'), text: z.string() })
const toolResultSchema = z.looseObject({
  content: z.array(z.unknown()),
  details: z
    .looseObject({
      exitCode: z.number().int().safe().optional(),
      wallTimeMs: z.number().optional()
    })
    .optional()
})

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
  const exitCode = parsed.data.details?.exitCode
  const stdout = commandOutput(
    texts.join('\n'),
    exitCode,
    parsed.data.details?.wallTimeMs !== undefined
  )
  return {
    ...update,
    content,
    rawOutput: { ...parsed.data, stdout, ...(exitCode === undefined ? {} : { exitCode }) }
  }
}

export const OMP_ACP_DIALECT: AcpDialect = { normalizeToolUpdate }
